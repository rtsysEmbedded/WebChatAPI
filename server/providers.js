'use strict';

const { config, t } = require('./config');

const providers = config.providers.filter((p) => p.enabled);
const modelCache = new Map(); // providerId -> { at, models }

function getProvider(id) {
  return providers.find((p) => p.id === id) || null;
}

function pick(obj, dotted) {
  if (!dotted) return undefined;
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function toPricePerToken(value, unit) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n) || n < 0) return null;
  return n / unit;
}

// Map a provider-specific model object to the internal shape using the
// field paths declared in config.providers[].modelFields.
function normalizeModel(p, raw) {
  const f = p.modelFields;
  const caps = [].concat(pick(raw, f.capabilities) || []);
  const modalities = [].concat(pick(raw, f.inputModalities) || []);
  return {
    id: String(pick(raw, f.id)),
    name: pick(raw, f.name) || String(pick(raw, f.id)),
    description: pick(raw, f.description) || '',
    contextLength: Number(pick(raw, f.contextLength)) || null,
    inputPrice: toPricePerToken(pick(raw, f.inputPrice), p.priceUnitTokens),
    outputPrice: toPricePerToken(pick(raw, f.outputPrice), p.priceUnitTokens),
    vision: modalities.includes('image') || (p.visionCapability ? caps.includes(p.visionCapability) : false),
    video: modalities.includes('video') || (p.videoCapability ? caps.includes(p.videoCapability) : false),
    reasoning: caps.includes('reasoning') || caps.includes('include_reasoning'),
  };
}

function passesFilter(p, raw) {
  if (!p.modelFilter) return true;
  // Keep the model when the field is absent, equals an allowed value, or (for
  // array fields) contains at least one allowed value.
  const v = pick(raw, p.modelFilter.field);
  if (v === undefined) return true;
  return Array.isArray(v) ? v.some((x) => p.modelFilter.allow.includes(x)) : p.modelFilter.allow.includes(v);
}

function headersFor(p, apiKey) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...p.headers };
}

async function upstreamError(res) {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return (j.error && (j.error.message || j.error)) || j.message || text || res.statusText;
  } catch {
    return text || res.statusText;
  }
}

async function listModels(p, apiKey, refresh = false) {
  const cached = modelCache.get(p.id);
  if (!refresh && cached && Date.now() - cached.at < p.modelsCacheMinutes * 60e3) return cached.models;
  const res = await fetch(p.baseUrl + p.modelsPath, { headers: headersFor(p, apiKey) });
  if (!res.ok) throw new Error(t('server.errors.upstream', { status: res.status, message: await upstreamError(res) }));
  const body = await res.json();
  const rawList = Array.isArray(body) ? body : body.data || [];
  const models = rawList
    .filter((m) => passesFilter(p, m))
    .map((m) => normalizeModel(p, m))
    .concat(p.staticModels.map((m) => normalizeModel(p, m)))
    .sort((a, b) => a.name.localeCompare(b.name));
  modelCache.set(p.id, { at: Date.now(), models });
  return models;
}

// Parse an SSE byte stream into JSON payloads. Comment lines (": ping",
// ": OPENROUTER PROCESSING") are keep-alives and are skipped.
async function* sseJson(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* partial or non-JSON frame: ignore */
      }
    }
  }
}

// Build the request body for /chat/completions. `messages` are already in
// upstream (OpenAI) format; see context.js.
function buildBody(p, conversation, messages, stream) {
  const body = { ...p.extraBody, model: conversation.modelId, messages, stream };
  if (conversation.temperature != null) body.temperature = conversation.temperature;
  let maxTokens = conversation.maxTokens != null ? conversation.maxTokens : config.chat.defaultMaxTokens;
  if (maxTokens != null && p.minMaxTokens != null) maxTokens = Math.max(maxTokens, p.minMaxTokens);
  if (maxTokens != null) body.max_tokens = maxTokens;
  if (p.supportsReasoningEffort && conversation.reasoningEffort) body.reasoning_effort = conversation.reasoningEffort;
  return body;
}

// Serialize and enforce the provider's documented request-size limit, so an
// oversized request fails with a clear error instead of an opaque upstream one.
function serializeBody(p, body) {
  const json = JSON.stringify(body);
  const bytes = Buffer.byteLength(json);
  if (p.maxRequestBytes && bytes > p.maxRequestBytes) {
    const err = new Error('requestTooLarge');
    err.code = 'requestTooLarge';
    err.detail = t('server.errors.requestTooLarge', {
      size: (bytes / 1e6).toFixed(1),
      max: (p.maxRequestBytes / 1e6).toFixed(1),
      provider: p.name,
    });
    throw err;
  }
  return json;
}

async function post(p, apiKey, json, signal) {
  const res = await fetch(p.baseUrl + p.chatPath, { method: 'POST', headers: headersFor(p, apiKey), body: json, signal });
  if (!res.ok) throw new Error(t('server.errors.upstream', { status: res.status, message: await upstreamError(res) }));
  return res;
}

// Stream a chat completion. Yields { type: 'content'|'reasoning'|'usage', ... }
// and throws on upstream errors (including error frames sent mid-stream).
async function* streamChat(p, apiKey, json, signal) {
  const res = await post(p, apiKey, json, signal);
  for await (const chunk of sseJson(res.body)) {
    if (chunk.error) {
      const e = chunk.error;
      throw new Error(t('server.errors.upstream', { status: e.code || '-', message: e.message || JSON.stringify(e) }));
    }
    const choice = chunk.choices && chunk.choices[0];
    const delta = (choice && (choice.delta || choice.message)) || {};
    for (const field of p.reasoningFields) {
      if (typeof delta[field] === 'string' && delta[field]) {
        yield { type: 'reasoning', text: delta[field] };
        break;
      }
    }
    if (typeof delta.content === 'string' && delta.content) yield { type: 'content', text: delta.content };
    if (chunk.usage) yield { type: 'usage', usage: chunk.usage };
  }
}

// Create embeddings for a list of texts (OpenAI-compatible /embeddings).
// Returns an array of number arrays in input order.
async function embed(p, apiKey, model, inputs, dimensions, signal) {
  const body = { model, input: inputs, encoding_format: 'float' };
  if (dimensions) body.dimensions = dimensions;
  const res = await fetch(p.baseUrl + p.embeddingsPath, {
    method: 'POST',
    headers: headersFor(p, apiKey),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(t('server.errors.upstream', { status: res.status, message: await upstreamError(res) }));
  const data = await res.json();
  if (!Array.isArray(data.data)) throw new Error(t('server.errors.embeddingFormat'));
  return data.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Non-streaming completion; returns the answer text.
async function complete(p, apiKey, json, signal) {
  const res = await post(p, apiKey, json, signal);
  const data = await res.json();
  if (data.error) throw new Error(t('server.errors.upstream', { status: data.error.code || '-', message: data.error.message }));
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  return (msg && typeof msg.content === 'string' && msg.content) || '';
}

module.exports = {
  providers,
  getProvider,
  listModels,
  buildBody,
  serializeBody,
  streamChat,
  complete,
  embed,
  sseJson,
  normalizeModel,
  passesFilter,
};
