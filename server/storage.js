'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { config, resolvePath, log } = require('./config');

const dataDir = resolvePath(process.env[config.server.dataDirEnv] || config.server.dataDir);
const convDir = path.join(dataDir, 'conversations');
const uploadDir = path.join(dataDir, 'uploads');
const indexFile = path.join(dataDir, 'index.json');
const ID_RE = /^[a-f0-9-]{36}$/;

let index = {}; // id -> summary (no messages)
let writeChain = Promise.resolve();

function newId() {
  return crypto.randomUUID();
}

function isId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function now() {
  return new Date().toISOString();
}

function summary(c) {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    providerId: c.providerId,
    modelId: c.modelId,
    characterId: c.characterId || null,
    pinned: !!c.pinned,
  };
}

// Write to a temp file and rename, so a crash never leaves a half-written file.
async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

// All JSON-state writes go through one queue, so they never interleave.
function serialized(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log('server.log.conversationReadError', { file, error: err.message });
    return fallback;
  }
}

// ---- Conversations ---------------------------------------------------------

async function init() {
  await fsp.mkdir(convDir, { recursive: true });
  await fsp.mkdir(uploadDir, { recursive: true });
  try {
    index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
  } catch {
    index = {};
    for (const f of await fsp.readdir(convDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await fsp.readFile(path.join(convDir, f), 'utf8'));
        index[c.id] = summary(c);
      } catch (err) {
        log('server.log.conversationReadError', { file: f, error: err.message });
      }
    }
    await atomicWrite(indexFile, JSON.stringify(index));
  }
  await memory.load();
  await characters.load();
  log('server.log.storageReady', { dir: dataDir, count: Object.keys(index).length });
}

function list() {
  return Object.values(index).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

function exists(id) {
  return isId(id) && !!index[id];
}

async function get(id) {
  if (!exists(id)) return null;
  return JSON.parse(await fsp.readFile(path.join(convDir, `${id}.json`), 'utf8'));
}

function save(c) {
  c.updatedAt = now();
  return serialized(async () => {
    await atomicWrite(path.join(convDir, `${c.id}.json`), JSON.stringify(c));
    index[c.id] = summary(c);
    await atomicWrite(indexFile, JSON.stringify(index));
    return c;
  });
}

function remove(id) {
  if (!exists(id)) return Promise.resolve(false);
  return serialized(async () => {
    await fsp.rm(path.join(convDir, `${id}.json`), { force: true });
    delete index[id];
    await atomicWrite(indexFile, JSON.stringify(index));
    return true;
  }).then(async (ok) => {
    await uploads.removeForConversation(id);
    return ok;
  });
}

// ---- Generic list store (memory, characters) -----------------------------

function listStore(file) {
  let items = [];
  const persist = () => serialized(() => atomicWrite(file, JSON.stringify({ items }, null, 1)));
  return {
    async load() {
      items = (await readJsonFile(file, { items: [] })).items || [];
    },
    all() {
      return items.slice();
    },
    get(id) {
      return items.find((x) => x.id === id) || null;
    },
    get size() {
      return items.length;
    },
    async add(data) {
      const item = { id: newId(), ...data, createdAt: now(), updatedAt: now() };
      items.push(item);
      await persist();
      return item;
    },
    async update(id, patch) {
      const item = items.find((x) => x.id === id);
      if (!item) return null;
      Object.assign(item, patch, { updatedAt: now() });
      await persist();
      return item;
    },
    async remove(id) {
      const before = items.length;
      items = items.filter((x) => x.id !== id);
      if (items.length !== before) await persist();
      return items.length !== before;
    },
    async clear() {
      items = [];
      await persist();
    },
  };
}

const memory = listStore(path.join(dataDir, 'memory.json'));
const characters = listStore(path.join(dataDir, 'characters.json'));

// ---- Uploads ---------------------------------------------------------------
// data/uploads/<id>.bin   original bytes
// data/uploads/<id>.json  metadata { id, name, mime, kind, size, conversationId, ... }
// data/uploads/<id>.txt   extracted text (documents only)

const uploads = {
  paths(id) {
    const base = path.join(uploadDir, id);
    return { bin: `${base}.bin`, meta: `${base}.json`, txt: `${base}.txt` };
  },

  async create(meta, tmpFile, text) {
    const p = this.paths(meta.id);
    await fsp.rename(tmpFile, p.bin);
    if (text != null) await atomicWrite(p.txt, text);
    await atomicWrite(p.meta, JSON.stringify(meta));
    return meta;
  },

  tempPath() {
    return path.join(uploadDir, `incoming-${newId()}.tmp`);
  },

  async meta(id) {
    if (!isId(id)) return null;
    return readJsonFile(this.paths(id).meta, null);
  },

  async setConversation(id, conversationId) {
    const m = await this.meta(id);
    if (!m) return null;
    m.conversationId = conversationId;
    await atomicWrite(this.paths(id).meta, JSON.stringify(m));
    return m;
  },

  async bytes(id) {
    return fsp.readFile(this.paths(id).bin);
  },

  async text(id) {
    try {
      return await fsp.readFile(this.paths(id).txt, 'utf8');
    } catch {
      return '';
    }
  },

  async remove(id) {
    const p = this.paths(id);
    await Promise.all([p.bin, p.meta, p.txt].map((f) => fsp.rm(f, { force: true })));
  },

  async allMeta() {
    const out = [];
    for (const f of await fsp.readdir(uploadDir)) {
      if (!f.endsWith('.json')) continue;
      const m = await readJsonFile(path.join(uploadDir, f), null);
      if (m) out.push(m);
    }
    return out;
  },

  async removeForConversation(conversationId) {
    for (const m of await this.allMeta()) if (m.conversationId === conversationId) await this.remove(m.id);
  },

  // Remove uploads never attached to a message (older than the grace period),
  // uploads whose conversation no longer exists, and stale temp files.
  async cleanup() {
    const cutoff = Date.now() - config.attachments.orphanUploadHours * 3600e3;
    let removed = 0;
    for (const m of await this.allMeta()) {
      const orphan = m.conversationId ? !exists(m.conversationId) : Date.parse(m.createdAt) < cutoff;
      if (orphan) {
        await this.remove(m.id);
        removed++;
      }
    }
    for (const f of await fsp.readdir(uploadDir)) {
      if (!f.endsWith('.tmp')) continue;
      const st = await fsp.stat(path.join(uploadDir, f)).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fsp.rm(path.join(uploadDir, f), { force: true });
    }
    if (removed) log('server.log.uploadsCleaned', { count: removed });
  },
};

module.exports = { init, list, get, save, remove, exists, newId, isId, memory, characters, uploads };
