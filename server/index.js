'use strict';

const http = require('http');
const { config, i18n, log, loadSecrets } = require('./config');
const auth = require('./auth');
const storage = require('./storage');
const { providers, getProvider, listModels, clearModelCache, buildBody, serializeBody, streamChat } = require('./providers');
const context = require('./context');
const archive = require('./archive');
const settings = require('./settings');
const features = require('./features');
const H = require('./http');

const A = config.auth;
const C = config.chat;
const secrets = loadSecrets();

// ---- Helpers ---------------------------------------------------------------

function isAuthenticated(req) {
  if (!A.enabled) return true;
  return auth.verifyToken(H.parseCookies(req)[A.sessionCookieName], secrets);
}

function cookie(req, value, maxAgeSeconds) {
  const secure = A.secureCookie === 'auto' ? H.isSecureRequest(req) : !!A.secureCookie;
  return [
    `${A.sessionCookieName}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function now() {
  return new Date().toISOString();
}

function requireProvider(id) {
  const p = getProvider(id);
  if (!p) throw new H.HttpError(400, 'unknownProvider');
  const key = secrets.providerKeys[p.id];
  if (!key) throw new H.HttpError(400, 'providerKeyMissing', p.name);
  return { p, key };
}

// Whitelist + type-check user-editable conversation settings.
function applySettings(target, body) {
  if (typeof body.title === 'string') target.title = body.title.slice(0, 200);
  if (typeof body.providerId === 'string') {
    if (!getProvider(body.providerId)) throw new H.HttpError(400, 'unknownProvider');
    target.providerId = body.providerId;
  }
  if (typeof body.modelId === 'string' && body.modelId) target.modelId = body.modelId.slice(0, 300);
  if (typeof body.systemPrompt === 'string') target.systemPrompt = body.systemPrompt;
  if (body.temperature === null) target.temperature = null;
  else if (typeof body.temperature === 'number') {
    target.temperature = Math.min(C.temperatureMax, Math.max(C.temperatureMin, body.temperature));
  }
  if (body.maxTokens === null) target.maxTokens = null;
  else if (Number.isInteger(body.maxTokens) && body.maxTokens > 0) target.maxTokens = body.maxTokens;
  if (typeof body.reasoningEffort === 'string' && C.reasoningEfforts.includes(body.reasoningEffort)) {
    target.reasoningEffort = body.reasoningEffort;
  }
  if (typeof body.pinned === 'boolean') target.pinned = body.pinned;
  if (typeof body.useMemory === 'boolean') target.useMemory = body.useMemory;
  if (body.characterId === null) target.characterId = null;
  else if (typeof body.characterId === 'string') {
    if (!storage.characters.get(body.characterId)) throw new H.HttpError(400, 'notFound');
    target.characterId = body.characterId;
  }
  return target;
}

function makeTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > C.titleMaxLength ? clean.slice(0, C.titleMaxLength - 1) + '…' : clean;
}

// ---- Route handlers --------------------------------------------------------

function publicConfig() {
  return {
    app: config.app,
    ui: config.ui,
    auth: { enabled: A.enabled, pinMinLength: A.pinMinLength, pinMaxLength: A.pinMaxLength, pinPattern: A.pinPattern },
    chat: {
      defaultTemperature: C.defaultTemperature,
      temperatureMin: C.temperatureMin,
      temperatureMax: C.temperatureMax,
      temperatureStep: C.temperatureStep,
      defaultMaxTokens: C.defaultMaxTokens,
      defaultSystemPrompt: C.defaultSystemPrompt,
      reasoningEfforts: C.reasoningEfforts,
      defaultProviderId: C.defaultProviderId,
      defaultModelId: C.defaultModelId,
    },
    attachments: config.attachments,
    memory: {
      enabled: config.memory.enabled,
      defaultOnForNewChats: config.memory.defaultOnForNewChats,
      autoExtract: config.memory.autoExtract.enabled,
      maxItemChars: config.memory.maxItemChars,
      archive: archive.status(),
    },
    characters: config.characters,
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      configured: !!secrets.providerKeys[p.id],
      supportsReasoningEffort: p.supportsReasoningEffort,
    })),
  };
}

async function login(req, res) {
  const ip = H.clientIp(req);
  const locked = auth.lockStatus(ip);
  if (locked) return H.sendJson(res, 429, { error: 'locked', retryAfter: locked });
  if (!secrets.pinHash) return H.sendJson(res, 503, { error: 'pinNotConfigured' });
  const body = await H.readJsonBody(req);
  const ok = auth.validatePinFormat(body.pin) && (await auth.verifyPin(body.pin, secrets.pinHash));
  if (!ok) {
    auth.recordFailure(ip);
    log('server.log.loginFailed', { ip });
    await sleep(A.failedLoginDelayMs);
    const retry = auth.lockStatus(ip);
    return H.sendJson(res, retry ? 429 : 401, { error: retry ? 'locked' : 'invalidPin', retryAfter: retry || undefined });
  }
  auth.recordSuccess(ip);
  log('server.log.loginOk', { ip });
  res.setHeader('Set-Cookie', cookie(req, auth.createToken(secrets), A.sessionTtlHours * 3600));
  return H.sendJson(res, 200, { ok: true });
}

async function models(req, res, url) {
  const refresh = url.searchParams.get('refresh') === '1';
  const kind = url.searchParams.get('kind') === 'embedding' ? 'embedding' : 'chat';
  const result = await Promise.all(
    providers.map(async (p) => {
      const key = secrets.providerKeys[p.id];
      if (!key) return { providerId: p.id, providerName: p.name, models: [], error: 'providerKeyMissing' };
      try {
        return { providerId: p.id, providerName: p.name, models: await listModels(p, key, refresh, kind) };
      } catch (err) {
        return { providerId: p.id, providerName: p.name, models: [], error: 'upstream', detail: err.message };
      }
    }),
  );
  H.sendJson(res, 200, result);
}

async function createConversation(req, res) {
  const body = await H.readJsonBody(req);
  const c = applySettings(
    {
      id: storage.newId(),
      title: '',
      createdAt: now(),
      providerId: null,
      modelId: null,
      systemPrompt: C.defaultSystemPrompt,
      temperature: C.defaultTemperature,
      maxTokens: C.defaultMaxTokens,
      reasoningEffort: '',
      pinned: false,
      characterId: null,
      useMemory: config.memory.defaultOnForNewChats,
      messages: [],
    },
    body,
  );
  if (!c.providerId || !c.modelId) throw new H.HttpError(400, 'modelRequired');
  await storage.save(c);
  H.sendJson(res, 201, c);
}

async function loadConversation(id) {
  const c = await storage.get(id);
  if (!c) throw new H.HttpError(404, 'notFound');
  return c;
}

// POST /api/conversations/:id/chat — streams the answer as Server-Sent Events.
// Body: { content, attachments?: [uploadId], regenerate?, editFromMessageId? }
async function chat(req, res, id) {
  const body = await H.readJsonBody(req);
  const c = await loadConversation(id);
  const { p, key } = requireProvider(c.providerId);
  if (!c.modelId) throw new H.HttpError(400, 'modelRequired');

  let attachments = [];
  if (body.regenerate) {
    while (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
    if (!c.messages.length) throw new H.HttpError(400, 'nothingToRegenerate');
  } else {
    const content = typeof body.content === 'string' ? body.content : '';
    attachments = await features.resolveAttachments(body.attachments, c.id);
    if (!content.trim() && !attachments.length) throw new H.HttpError(400, 'emptyMessage');
    if (body.editFromMessageId) {
      const idx = c.messages.findIndex((m) => m.id === body.editFromMessageId);
      if (idx < 0 || c.messages[idx].role !== 'user') throw new H.HttpError(400, 'notFound');
      c.messages = c.messages.slice(0, idx);
    }
    c.messages.push({ id: storage.newId(), role: 'user', content, attachments, createdAt: now() });
  }

  // Build and size-check the upstream request before anything is stored, so
  // a rejected request leaves the conversation unchanged.
  let json;
  try {
    json = serializeBody(p, buildBody(p, c, await context.upstreamMessages(c, c.messages), true));
  } catch (err) {
    if (err.code === 'requestTooLarge') throw new H.HttpError(413, 'requestTooLarge', err.detail);
    throw err;
  }

  if (!c.title) {
    const first = c.messages.find((m) => m.role === 'user');
    c.title = makeTitle(first.content || (first.attachments && first.attachments[0] && first.attachments[0].name));
  }
  for (const a of attachments) await storage.uploads.setConversation(a.id, c.id);
  await storage.save(c);

  const assistant = {
    id: storage.newId(),
    role: 'assistant',
    content: '',
    reasoning: '',
    providerId: p.id,
    modelId: c.modelId,
    characterId: c.characterId || null,
    createdAt: now(),
    usage: null,
    error: null,
    stopped: false,
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const open = () => !res.writableEnded && !res.destroyed;
  const send = (event, data) => open() && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { conversation: { ...c, messages: undefined }, messages: c.messages, assistantId: assistant.id });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), C.upstreamTimeoutSeconds * 1000);
  const keepAlive = setInterval(() => open() && res.write(': ping\n\n'), config.server.sseKeepAliveSeconds * 1000);
  res.on('close', () => {
    if (!res.writableEnded) {
      assistant.stopped = true;
      controller.abort();
    }
  });

  try {
    for await (const ev of streamChat(p, key, json, controller.signal)) {
      if (ev.type === 'content') assistant.content += ev.text;
      else if (ev.type === 'reasoning') assistant.reasoning += ev.text;
      else if (ev.type === 'usage') assistant.usage = ev.usage;
      send(ev.type === 'usage' ? 'usage' : 'delta', ev);
    }
  } catch (err) {
    if (!assistant.stopped) {
      assistant.error = err.message;
      log('server.log.chatError', { provider: p.id, model: c.modelId, error: err.message });
    }
  } finally {
    clearTimeout(timeout);
  }

  c.messages.push(assistant);
  await storage.save(c);
  send('done', { message: assistant, conversation: { ...c, messages: undefined } });

  // Long-term memory: runs after the answer is complete, so it never delays
  // it, and also when the browser has already disconnected. The UI is told
  // about changes (or a failure) through a final 'memory' event.
  if (!assistant.stopped && !assistant.error && !body.regenerate) {
    const mem = await context.extractMemory(c, secrets.providerKeys);
    if (mem.added.length || mem.removed.length || mem.saved || mem.error) send('memory', mem);
  }
  clearInterval(keepAlive);
  if (open()) res.end();
}

// /api/memory/archive[/:id] — saved conversation summaries.
async function archiveRoute(req, res, url, method, id) {
  if (!archive.enabled()) throw new H.HttpError(400, 'archiveDisabled');
  if (!id && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const items = q ? await archive.search(q, { topK: limit }) : archive.list(offset, limit);
    return H.sendJson(res, 200, { items, status: archive.status() });
  }
  if (!id && method === 'DELETE') {
    archive.clear();
    return H.sendJson(res, 200, { ok: true });
  }
  if (id && method === 'GET') {
    const entry = archive.get(id);
    if (!entry) throw new H.HttpError(404, 'notFound');
    return H.sendJson(res, 200, entry);
  }
  if (id && method === 'PATCH') {
    const body = await H.readJsonBody(req);
    const patch = {};
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 200);
    if (typeof body.text === 'string' && body.text.trim()) patch.text = body.text.trim();
    const entry = await archive.update(id, patch);
    if (!entry) throw new H.HttpError(404, 'notFound');
    return H.sendJson(res, 200, entry);
  }
  if (id && method === 'DELETE') {
    if (!archive.remove(id)) throw new H.HttpError(404, 'notFound');
    return H.sendJson(res, 200, { ok: true });
  }
  throw new H.HttpError(404, 'notFound');
}

// ---- Router ----------------------------------------------------------------

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname;
  const method = req.method;
  H.applySecurityHeaders(res);

  if (!path.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') return H.sendJson(res, 405, { error: 'methodNotAllowed' });
    return H.serveStatic(req, res, path);
  }

  if (method !== 'GET' && !H.checkOrigin(req)) throw new H.HttpError(403, 'badOrigin');

  // Public endpoints (needed before login).
  if (method === 'GET' && path === '/api/public-config') return H.sendJson(res, 200, publicConfig());
  if (method === 'GET' && path.startsWith('/api/i18n/')) {
    const lang = path.slice('/api/i18n/'.length);
    if (!i18n[lang]) throw new H.HttpError(404, 'notFound');
    return H.sendJson(res, 200, { meta: i18n[lang].meta, ui: i18n[lang].ui });
  }
  if (method === 'GET' && path === '/api/auth/status') {
    return H.sendJson(res, 200, {
      authenticated: isAuthenticated(req),
      authEnabled: A.enabled,
      pinConfigured: !!secrets.pinHash,
      lockedSeconds: auth.lockStatus(H.clientIp(req)),
    });
  }
  if (method === 'POST' && path === '/api/auth/login') return login(req, res);
  if (method === 'POST' && path === '/api/auth/logout') {
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    return H.sendJson(res, 200, { ok: true });
  }

  if (!isAuthenticated(req)) throw new H.HttpError(401, 'unauthorized');
  if (A.enabled && auth.needsRenewal(H.parseCookies(req)[A.sessionCookieName])) {
    res.setHeader('Set-Cookie', cookie(req, auth.createToken(secrets), A.sessionTtlHours * 3600));
  }

  if (method === 'GET' && path === '/api/models') return models(req, res, url);
  if (method === 'GET' && path === '/api/conversations') return H.sendJson(res, 200, storage.list());
  if (method === 'POST' && path === '/api/conversations') return createConversation(req, res);
  if (method === 'POST' && path === '/api/uploads') return features.upload(req, res);

  const up = /^\/api\/uploads\/([^/]+)$/.exec(path);
  if (up && method === 'GET') return features.serveUpload(req, res, up[1]);
  if (up && method === 'DELETE') return features.deleteUpload(res, up[1]);

  const providerTest = /^\/api\/providers\/([^/]+)\/test$/.exec(path);
  if (providerTest && method === 'POST') {
    const { p, key } = requireProvider(decodeURIComponent(providerTest[1]));
    try {
      const list = await listModels(p, key, true, 'chat');
      return H.sendJson(res, 200, { ok: true, count: list.length });
    } catch (err) {
      return H.sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  if (path === '/api/settings') {
    if (method === 'GET') return H.sendJson(res, 200, { sections: settings.schema(), values: settings.values() });
    if (method === 'PATCH' || method === 'DELETE') {
      try {
        const values = method === 'PATCH' ? await settings.update(await H.readJsonBody(req)) : await settings.reset();
        return H.sendJson(res, 200, { sections: settings.schema(), values });
      } catch (err) {
        if (err instanceof settings.SettingError) throw new H.HttpError(400, 'invalidSetting', err.fieldId);
        throw err;
      }
    }
  }

  const arc = /^\/api\/memory\/archive(?:\/([^/]+))?$/.exec(path);
  if (arc) return archiveRoute(req, res, url, method, arc[1]);

  const mem = /^\/api\/memory(?:\/([^/]+))?$/.exec(path);
  if (mem) return features.memoryRoute(req, res, method, mem[1]);

  const chr = /^\/api\/characters(?:\/([^/]+))?$/.exec(path);
  if (chr) return features.charactersRoute(req, res, method, chr[1]);

  const rem = /^\/api\/conversations\/([^/]+)\/remember$/.exec(path);
  if (rem && method === 'POST') {
    if (!archive.enabled()) throw new H.HttpError(400, 'archiveDisabled');
    const c = await loadConversation(rem[1]);
    try {
      return H.sendJson(res, 201, await context.summarizeConversation(c, secrets.providerKeys));
    } catch (err) {
      throw new H.HttpError(502, 'summaryFailed', err.message);
    }
  }

  const m = /^\/api\/conversations\/([^/]+)(\/chat)?$/.exec(path);
  if (m) {
    const id = m[1];
    if (m[2] && method === 'POST') return chat(req, res, id);
    if (!m[2] && method === 'GET') return H.sendJson(res, 200, await loadConversation(id));
    if (!m[2] && method === 'PATCH') {
      const c = applySettings(await loadConversation(id), await H.readJsonBody(req));
      return H.sendJson(res, 200, await storage.save(c));
    }
    if (!m[2] && method === 'DELETE') {
      if (!(await storage.remove(id))) throw new H.HttpError(404, 'notFound');
      return H.sendJson(res, 200, { ok: true });
    }
  }
  throw new H.HttpError(404, 'notFound');
}

async function main() {
  await storage.init();
  await settings.init(storage.dataDir, secrets); // apply panel overrides before anything reads config
  archive.init(storage.dataDir, secrets.providerKeys);
  settings.onChange((paths) => {
    if (paths.some((p) => p.startsWith('memory.archive.embedding.'))) archive.embeddingChanged();
    for (const p of providers) {
      if (paths.some((x) => x.startsWith(`providers.${p.id}.`))) clearModelCache(p.id);
    }
    const embedProvider = config.memory.archive.embedding.providerId;
    if (embedProvider && paths.some((x) => x.startsWith(`providers.${embedProvider}.`))) archive.reindex();
  });
  await storage.uploads.cleanup();
  setInterval(() => storage.uploads.cleanup().catch(() => {}), config.attachments.cleanupIntervalMinutes * 60e3).unref();
  if (A.enabled && !secrets.pinHash && secrets.pin) {
    if (!auth.validatePinFormat(secrets.pin)) log('server.log.pinEnvInvalid');
    else secrets.pinHash = await auth.hashPin(secrets.pin);
  } else {
    secrets.pin = null; // a stored hash takes precedence over a plain env PIN
  }
  if (A.enabled && !secrets.pinHash) log('server.log.pinMissing');
  for (const p of providers) if (!secrets.providerKeys[p.id]) log('server.log.providerKeyMissing', { provider: p.name, env: p.apiKeyEnv });

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!(err instanceof H.HttpError)) log('server.log.unhandled', { error: err.stack || err.message });
      if (!res.headersSent) H.sendError(res, err);
      else res.end();
    });
  });
  // Long-lived SSE streams must not be cut by Node's default timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60e3;

  const port = Number(process.env[config.server.portEnv]) || config.server.port;
  const host = process.env[config.server.hostEnv] || config.server.host;
  server.listen(port, host, () => log('server.log.listening', { host, port }));
}

main().catch((err) => {
  log('server.log.fatal', { error: err.stack || err.message });
  process.exit(1);
});
