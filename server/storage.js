'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { config, resolvePath, log } = require('./config');

const dataDir = resolvePath(process.env[config.server.dataDirEnv] || config.server.dataDir);
const convDir = path.join(dataDir, 'conversations');
const indexFile = path.join(dataDir, 'index.json');
const ID_RE = /^[a-f0-9-]{36}$/;

let index = {}; // id -> summary (no messages)
let writeChain = Promise.resolve();

function newId() {
  return crypto.randomUUID();
}

function summary(c) {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    providerId: c.providerId,
    modelId: c.modelId,
    pinned: !!c.pinned,
  };
}

// Write to a temp file and rename, so a crash never leaves a half-written file.
async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

function serialized(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

async function init() {
  await fsp.mkdir(convDir, { recursive: true });
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
  log('server.log.storageReady', { dir: dataDir, count: Object.keys(index).length });
}

function list() {
  return Object.values(index).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

async function get(id) {
  if (!ID_RE.test(id) || !index[id]) return null;
  return JSON.parse(await fsp.readFile(path.join(convDir, `${id}.json`), 'utf8'));
}

function save(c) {
  c.updatedAt = new Date().toISOString();
  return serialized(async () => {
    await atomicWrite(path.join(convDir, `${c.id}.json`), JSON.stringify(c));
    index[c.id] = summary(c);
    await atomicWrite(indexFile, JSON.stringify(index));
    return c;
  });
}

function remove(id) {
  if (!ID_RE.test(id) || !index[id]) return Promise.resolve(false);
  return serialized(async () => {
    await fsp.rm(path.join(convDir, `${id}.json`), { force: true });
    delete index[id];
    await atomicWrite(indexFile, JSON.stringify(index));
    return true;
  });
}

module.exports = { init, list, get, save, remove, newId };
