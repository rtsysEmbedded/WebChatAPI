'use strict';

// Long-term memory archive: conversation summaries (and notes) stored in
// SQLite (node:sqlite, built into Node.js) with
//   - an FTS5 index for keyword search (BM25), and
//   - embedding vectors (BLOB) for semantic search.
// Retrieval fuses both rankings with Reciprocal Rank Fusion (RRF). Vector
// search is an exact brute-force cosine scan over an in-memory cache, which
// stays fast for tens of thousands of entries on a single-user server.

const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { config, log } = require('./config');
const { getProvider, embed } = require('./providers');

const A = config.memory.archive;
const R = A.retrieval;
const E = A.embedding;

let db = null;
let keys = {};
const vectors = new Map(); // id -> Float32Array (unit length) for the current model
let reindexing = null;

function now() {
  return new Date().toISOString();
}

// Identifies the vectors' model; stored per entry so a model change is
// detected and triggers re-embedding.
function modelKey() {
  return E.providerId && E.modelId ? `${E.providerId}:${E.modelId}:${E.dimensions || ''}` : null;
}

function embeddingProvider() {
  if (!modelKey()) return null;
  const p = getProvider(E.providerId);
  const key = p && keys[p.id];
  return key ? { p, key } : null;
}

function toUnit(values) {
  const v = Float32Array.from(values);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function blobToVector(blob) {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function embedText(entry) {
  return `${entry.title}\n${entry.text}`.slice(0, E.maxInputChars);
}

// ---- Setup -------------------------------------------------------------------

function init(dataDir, providerKeys) {
  keys = providerKeys;
  if (!A.enabled) return;
  db = new DatabaseSync(path.join(dataDir, A.dbFile));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      conversationId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      embedModel TEXT,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS entries_conversation ON entries(conversationId);
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      id UNINDEXED, title, text, tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  const current = modelKey();
  for (const row of db.prepare('SELECT id, embedModel, embedding FROM entries WHERE embedding IS NOT NULL').all()) {
    if (row.embedModel === current) vectors.set(row.id, blobToVector(row.embedding));
  }
  reindex(); // background: embed entries that have no vector for the current model
}

// Called when the embedding model setting changes at runtime: load the
// vectors made with the new model and embed everything else.
function embeddingChanged() {
  if (!db) return;
  vectors.clear();
  const current = modelKey();
  if (current) {
    for (const row of db.prepare('SELECT id, embedding FROM entries WHERE embedModel = ?').all(current)) {
      vectors.set(row.id, blobToVector(row.embedding));
    }
  }
  reindex();
}

function enabled() {
  return !!db;
}

// ---- Embeddings ----------------------------------------------------------------

async function embedMany(texts) {
  const ep = embeddingProvider();
  if (!ep) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += E.batchSize) {
    const batch = texts.slice(i, i + E.batchSize);
    const res = await embed(ep.p, ep.key, E.modelId, batch, E.dimensions, AbortSignal.timeout(E.timeoutSeconds * 1000));
    out.push(...res.map(toUnit));
  }
  return out;
}

function storeVector(id, vec) {
  db.prepare('UPDATE entries SET embedModel = ?, embedding = ? WHERE id = ?').run(
    modelKey(),
    new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength),
    id,
  );
  vectors.set(id, vec);
}

async function embedEntry(entry) {
  try {
    const res = await embedMany([embedText(entry)]);
    if (res) storeVector(entry.id, res[0]);
  } catch (err) {
    log('server.log.embeddingError', { error: err.message });
  }
}

// Embed every entry without a vector for the current model (after a model
// change, or when embedding failed earlier). Runs once at a time.
function reindex() {
  if (!db || !embeddingProvider() || reindexing) return reindexing;
  reindexing = (async () => {
    const current = modelKey();
    const rows = db
      .prepare('SELECT id, title, text FROM entries WHERE embedModel IS NULL OR embedModel != ?')
      .all(current);
    if (!rows.length) return;
    log('server.log.reindexStart', { count: rows.length, model: current });
    try {
      for (let i = 0; i < rows.length; i += E.batchSize) {
        const batch = rows.slice(i, i + E.batchSize);
        const vecs = await embedMany(batch.map(embedText));
        batch.forEach((row, j) => storeVector(row.id, vecs[j]));
      }
      log('server.log.reindexDone', { count: rows.length });
    } catch (err) {
      log('server.log.embeddingError', { error: err.message });
    }
  })().finally(() => {
    reindexing = null;
  });
  return reindexing;
}

// ---- CRUD ----------------------------------------------------------------------

const COLUMNS = 'id, kind, title, text, conversationId, createdAt, updatedAt, embedModel';

function publicEntry(row) {
  if (!row) return null;
  const { embedModel, ...rest } = row;
  return { ...rest, embedded: !!embedModel && embedModel === modelKey() };
}

function writeFts(entry) {
  db.prepare('DELETE FROM entries_fts WHERE id = ?').run(entry.id);
  db.prepare('INSERT INTO entries_fts (id, title, text) VALUES (?, ?, ?)').run(entry.id, entry.title, entry.text);
}

// One summary per conversation: saving the same chat again replaces it.
async function upsertConversation({ conversationId, title, text }) {
  const existing = db.prepare(`SELECT ${COLUMNS} FROM entries WHERE kind = 'summary' AND conversationId = ?`).get(conversationId);
  const entry = existing
    ? { ...existing, title, text, updatedAt: now() }
    : { id: crypto.randomUUID(), kind: 'summary', title, text, conversationId, createdAt: now(), updatedAt: now() };
  if (existing) {
    db.prepare('UPDATE entries SET title = ?, text = ?, updatedAt = ?, embedModel = NULL, embedding = NULL WHERE id = ?').run(
      title,
      text,
      entry.updatedAt,
      entry.id,
    );
    vectors.delete(entry.id);
  } else {
    db.prepare(
      'INSERT INTO entries (id, kind, title, text, conversationId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(entry.id, entry.kind, title, text, conversationId, entry.createdAt, entry.updatedAt);
  }
  writeFts(entry);
  await embedEntry(entry);
  return get(entry.id);
}

function get(id) {
  return publicEntry(db.prepare(`SELECT ${COLUMNS} FROM entries WHERE id = ?`).get(id));
}

function list(offset, limit) {
  return db
    .prepare(`SELECT ${COLUMNS} FROM entries ORDER BY updatedAt DESC LIMIT ? OFFSET ?`)
    .all(limit, offset)
    .map(publicEntry);
}

async function update(id, { title, text }) {
  const row = db.prepare(`SELECT ${COLUMNS} FROM entries WHERE id = ?`).get(id);
  if (!row) return null;
  const entry = { ...row, title: title ?? row.title, text: text ?? row.text, updatedAt: now() };
  db.prepare('UPDATE entries SET title = ?, text = ?, updatedAt = ?, embedModel = NULL, embedding = NULL WHERE id = ?').run(
    entry.title,
    entry.text,
    entry.updatedAt,
    id,
  );
  vectors.delete(id);
  writeFts(entry);
  await embedEntry(entry);
  return get(id);
}

function remove(id) {
  const res = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
  vectors.delete(id);
  return res.changes > 0;
}

function clear() {
  db.exec('DELETE FROM entries; DELETE FROM entries_fts;');
  vectors.clear();
}

function status() {
  if (!db) return { enabled: false, count: 0, embedded: 0, mode: 'off' };
  const count = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
  return { enabled: true, count, embedded: vectors.size, mode: embeddingProvider() ? 'hybrid' : 'keyword' };
}

// ---- Search ----------------------------------------------------------------------

// FTS5 query: OR of quoted tokens (letters/digits in any script), so user
// text can never inject FTS syntax.
function ftsQuery(text) {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((tk) => tk.length >= R.minTokenLength);
  const unique = [...new Set(tokens)].slice(-R.maxQueryTokens);
  return unique.map((tk) => `"${tk.replace(/"/g, '""')}"`).join(' OR ');
}

function keywordSearch(text, limit) {
  const q = ftsQuery(text);
  if (!q) return [];
  return db
    .prepare('SELECT id FROM entries_fts WHERE entries_fts MATCH ? ORDER BY bm25(entries_fts) LIMIT ?')
    .all(q, limit)
    .map((r) => r.id);
}

async function vectorSearch(text, limit) {
  if (!vectors.size) return [];
  const res = await embedMany([text.slice(0, E.maxInputChars)]);
  if (!res) return [];
  const q = res[0];
  const scored = [];
  for (const [id, v] of vectors) {
    if (v.length !== q.length) continue;
    const s = dot(q, v);
    if (s >= R.minSimilarity) scored.push({ id, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.id);
}

// Reciprocal Rank Fusion: score(d) = Σ 1 / (k + rank_i(d)).
function fuse(rankings, k) {
  const scores = new Map();
  for (const list of rankings) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

// Returns up to `topK` entries relevant to `text`, excluding entries of the
// given conversation (its content is already in the context).
async function search(text, { excludeConversationId = null, topK = R.topK } = {}) {
  if (!db || !text || !text.trim()) return [];
  const keyword = keywordSearch(text, R.candidates);
  let semantic = [];
  try {
    semantic = await vectorSearch(text, R.candidates);
  } catch (err) {
    log('server.log.embeddingError', { error: err.message });
  }
  const out = [];
  for (const [id, score] of fuse([semantic, keyword], R.rrfK)) {
    const entry = get(id);
    if (!entry || (excludeConversationId && entry.conversationId === excludeConversationId)) continue;
    out.push({ ...entry, score, via: [semantic.includes(id) && 'vector', keyword.includes(id) && 'keyword'].filter(Boolean) });
    if (out.length >= topK) break;
  }
  return out;
}

module.exports = {
  init,
  enabled,
  embeddingChanged,
  upsertConversation,
  get,
  list,
  update,
  remove,
  clear,
  status,
  search,
  reindex,
  ftsQuery,
  fuse,
};
