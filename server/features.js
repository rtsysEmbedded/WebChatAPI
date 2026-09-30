'use strict';

// HTTP handlers for uploads, long-term memory and characters.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { config } = require('./config');
const storage = require('./storage');
const { extractText } = require('./extract');
const { getProvider } = require('./providers');
const H = require('./http');

const X = config.attachments;
const M = config.memory;
const CH = config.characters;

// ---- Uploads ---------------------------------------------------------------

// Classify by extension first (browsers report unreliable MIME types for
// source code), then by MIME type.
function classify(name, mime) {
  const ext = path.extname(name).toLowerCase();
  for (const [kind, k] of Object.entries(X.kinds)) if (k.extensions.includes(ext)) return kind;
  for (const [kind, k] of Object.entries(X.kinds)) if (k.mimeTypes.includes(mime)) return kind;
  return null;
}

function cleanName(raw) {
  let name = '';
  try {
    name = decodeURIComponent(raw || '');
  } catch {
    name = '';
  }
  // Keep only the base name and drop control characters.
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 255);
}

// Stream the request body to a temp file, enforcing the size limit while
// reading (Content-Length can be absent or wrong).
function receive(req, file, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      req.unpipe(out);
      req.resume();
      fsp.rm(file, { force: true }).finally(() => reject(err));
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) fail(new H.HttpError(413, 'fileTooLarge'));
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => !failed && resolve(size));
    req.pipe(out);
  });
}

async function upload(req, res) {
  const name = cleanName(req.headers['x-file-name']);
  if (!name) throw new H.HttpError(400, 'invalidFile');
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const kind = classify(name, mime);
  if (!kind) throw new H.HttpError(415, 'unsupportedFile', name);
  const k = X.kinds[kind];
  // Media is sent to the provider with its MIME type, so it must be a known one.
  if ((kind === 'image' || kind === 'video') && !k.mimeTypes.includes(mime)) {
    throw new H.HttpError(415, 'unsupportedFile', name);
  }
  const declared = Number(req.headers['content-length']);
  if (declared > k.maxBytes) throw new H.HttpError(413, 'fileTooLarge', name);

  const tmp = storage.uploads.tempPath();
  const size = await receive(req, tmp, k.maxBytes);
  if (!size) {
    await fsp.rm(tmp, { force: true });
    throw new H.HttpError(400, 'emptyFile', name);
  }

  let extracted = null;
  try {
    const buffer = await fsp.readFile(tmp);
    if (kind === 'text' && buffer.includes(0)) throw new H.HttpError(415, 'unsupportedFile', name);
    extracted = await extractText(kind, buffer);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    if (err instanceof H.HttpError) throw err;
    throw new H.HttpError(422, 'extractFailed', `${name}: ${err.message}`);
  }

  const meta = {
    id: storage.newId(),
    name,
    mime: mime || 'application/octet-stream',
    kind,
    size,
    createdAt: new Date().toISOString(),
    conversationId: null,
    textChars: extracted ? extracted.text.length : null,
    truncated: extracted ? !!extracted.truncated : false,
    pages: extracted && extracted.pagesTotal ? extracted.pagesTotal : null,
  };
  await storage.uploads.create(meta, tmp, extracted ? extracted.text : null);
  H.sendJson(res, 201, meta);
}

// Images and videos are served inline (for previews, with Range support so
// video seeking works in Safari); documents are only offered as downloads.
async function serveUpload(req, res, id) {
  const meta = await storage.uploads.meta(id);
  if (!meta) throw new H.HttpError(404, 'notFound');
  const file = storage.uploads.paths(id).bin;
  const st = await fsp.stat(file);
  const media = meta.kind === 'image' || meta.kind === 'video';
  const headers = {
    'Content-Type': media ? meta.mime : 'application/octet-stream',
    'Content-Disposition': `${media ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, max-age=86400',
    'Accept-Ranges': 'bytes',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(file).pipe(res);
}

async function deleteUpload(res, id) {
  const meta = await storage.uploads.meta(id);
  if (!meta) throw new H.HttpError(404, 'notFound');
  // Attachments that belong to a sent message are removed with their chat.
  if (meta.conversationId) throw new H.HttpError(409, 'uploadInUse');
  await storage.uploads.remove(id);
  H.sendJson(res, 200, { ok: true });
}

// Validate attachment ids for a message in conversation `conversationId`.
async function resolveAttachments(ids, conversationId) {
  if (ids == null) return [];
  if (!Array.isArray(ids) || ids.length > X.maxFilesPerMessage) throw new H.HttpError(400, 'tooManyFiles');
  const out = [];
  for (const id of ids) {
    const meta = await storage.uploads.meta(id);
    if (!meta || (meta.conversationId && meta.conversationId !== conversationId)) {
      throw new H.HttpError(400, 'invalidFile');
    }
    out.push({ id: meta.id, name: meta.name, kind: meta.kind, mime: meta.mime, size: meta.size, truncated: meta.truncated });
  }
  return out;
}

// ---- Memory ----------------------------------------------------------------

function memoryText(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new H.HttpError(400, 'emptyMessage');
  if (text.length > M.maxItemChars) throw new H.HttpError(400, 'memoryTooLong');
  return text;
}

async function memoryRoute(req, res, method, id) {
  if (!id && method === 'GET') return H.sendJson(res, 200, { items: storage.memory.all() });
  if (!id && method === 'POST') {
    if (storage.memory.size >= M.maxItems) throw new H.HttpError(400, 'memoryFull');
    const text = memoryText(await H.readJsonBody(req));
    return H.sendJson(res, 201, await storage.memory.add({ text, source: 'manual', conversationId: null }));
  }
  if (!id && method === 'DELETE') {
    await storage.memory.clear();
    return H.sendJson(res, 200, { ok: true });
  }
  if (id && method === 'PATCH') {
    const item = await storage.memory.update(id, { text: memoryText(await H.readJsonBody(req)) });
    if (!item) throw new H.HttpError(404, 'notFound');
    return H.sendJson(res, 200, item);
  }
  if (id && method === 'DELETE') {
    if (!(await storage.memory.remove(id))) throw new H.HttpError(404, 'notFound');
    return H.sendJson(res, 200, { ok: true });
  }
  throw new H.HttpError(404, 'notFound');
}

// ---- Characters ------------------------------------------------------------

function characterFields(body, existing) {
  const out = {};
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  const name = str(body.name, CH.nameMaxLength);
  if (name !== undefined) out.name = name;
  if (!existing && !name) throw new H.HttpError(400, 'nameRequired');
  if (name === '') throw new H.HttpError(400, 'nameRequired');
  const avatar = str(body.avatar, CH.avatarMaxLength);
  if (avatar !== undefined) out.avatar = avatar || CH.defaultAvatar;
  const description = str(body.description, CH.descriptionMaxLength);
  if (description !== undefined) out.description = description;
  if (typeof body.systemPrompt === 'string') out.systemPrompt = body.systemPrompt;
  if (body.providerId === null || body.modelId === null) {
    out.providerId = null;
    out.modelId = null;
  } else if (typeof body.providerId === 'string' && typeof body.modelId === 'string') {
    if (!getProvider(body.providerId)) throw new H.HttpError(400, 'unknownProvider');
    out.providerId = body.providerId;
    out.modelId = body.modelId.slice(0, 300);
  }
  if (body.temperature === null) out.temperature = null;
  else if (typeof body.temperature === 'number') {
    out.temperature = Math.min(config.chat.temperatureMax, Math.max(config.chat.temperatureMin, body.temperature));
  }
  if (typeof body.useMemory === 'boolean') out.useMemory = body.useMemory;
  return out;
}

async function charactersRoute(req, res, method, id) {
  if (!id && method === 'GET') return H.sendJson(res, 200, { items: storage.characters.all() });
  if (!id && method === 'POST') {
    if (storage.characters.size >= CH.maxCount) throw new H.HttpError(400, 'tooManyCharacters');
    const fields = characterFields(await H.readJsonBody(req), null);
    const item = await storage.characters.add({
      avatar: CH.defaultAvatar,
      description: '',
      systemPrompt: '',
      providerId: null,
      modelId: null,
      temperature: null,
      useMemory: M.defaultOnForNewChats,
      ...fields,
    });
    return H.sendJson(res, 201, item);
  }
  if (id && method === 'PATCH') {
    if (!storage.characters.get(id)) throw new H.HttpError(404, 'notFound');
    const item = await storage.characters.update(id, characterFields(await H.readJsonBody(req), storage.characters.get(id)));
    return H.sendJson(res, 200, item);
  }
  if (id && method === 'DELETE') {
    if (!(await storage.characters.remove(id))) throw new H.HttpError(404, 'notFound');
    return H.sendJson(res, 200, { ok: true });
  }
  throw new H.HttpError(404, 'notFound');
}

module.exports = { upload, serveUpload, deleteUpload, resolveAttachments, memoryRoute, charactersRoute, classify };
