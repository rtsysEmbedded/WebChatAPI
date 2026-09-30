'use strict';

// Builds what is sent to the model: the system prompt (character + chat
// prompt + long-term memory) and the message list with attachments resolved.
// Also runs the automatic memory extraction after a reply.

const { config, prompts, fill, log } = require('./config');
const storage = require('./storage');
const { getProvider, buildBody, serializeBody, complete } = require('./providers');

const P = prompts;
const TEXT_KINDS = new Set(['text', 'pdf', 'docx']);

function memoryActive(conversation) {
  return config.memory.enabled && conversation.useMemory !== false;
}

function memoryList(items) {
  return items.map((m) => fill(P.memory.item, { text: m.text })).join('\n');
}

function systemPrompt(conversation) {
  const parts = [];
  const character = conversation.characterId ? storage.characters.get(conversation.characterId) : null;
  if (character && character.systemPrompt) parts.push(character.systemPrompt);
  if (conversation.systemPrompt) parts.push(conversation.systemPrompt);
  if (memoryActive(conversation)) {
    const items = storage.memory.all();
    if (items.length) parts.push(fill(P.memory.block, { items: memoryList(items) }));
  }
  return parts.join(P.systemJoiner);
}

async function dataUrl(att) {
  const kindCfg = config.attachments.kinds[att.kind];
  const mime = (kindCfg && kindCfg.upstreamMime[att.mime]) || att.mime;
  const bytes = await storage.uploads.bytes(att.id);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

// Convert one stored user message into upstream content: documents become
// text blocks (placed before the user's text), images and videos become
// media parts. Plain string content is used when there is no media, because
// some providers reject array content.
async function userContent(m) {
  const texts = [];
  const media = [];
  for (const att of m.attachments || []) {
    const meta = await storage.uploads.meta(att.id);
    if (!meta) continue; // deleted upload
    if (TEXT_KINDS.has(meta.kind)) {
      const text = await storage.uploads.text(meta.id);
      texts.push(
        fill(P.attachments.document, { name: meta.name, text: text.trim() || P.attachments.empty }) +
          (meta.truncated ? P.attachments.truncatedNote : ''),
      );
    } else if (meta.kind === 'image') {
      media.push({ type: 'image_url', image_url: { url: await dataUrl(meta) } });
    } else if (meta.kind === 'video') {
      media.push({ type: 'video_url', video_url: { url: await dataUrl(meta) } });
    }
  }
  // Inline data-URL images from conversations created before uploads existed.
  for (const url of m.images || []) media.push({ type: 'image_url', image_url: { url } });

  if (m.content) texts.push(m.content);
  const text = texts.join('\n\n');
  return media.length ? [{ type: 'text', text }, ...media] : text;
}

async function upstreamMessages(conversation, messages) {
  const out = [];
  const sys = systemPrompt(conversation);
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: await userContent(m) });
    else if (m.role === 'assistant' && m.content) out.push({ role: 'assistant', content: m.content });
  }
  return out;
}

// ---- Automatic memory extraction -----------------------------------------

function normalizeFact(s) {
  return s.toLowerCase().replace(/[\s.!؟?,،]+/g, ' ').trim();
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// Returns the list of memory items added (possibly empty). Never throws.
async function extractMemory(conversation, userMsg, assistantMsg, providerKeys) {
  const cfg = config.memory.autoExtract;
  if (!memoryActive(conversation) || !cfg.enabled) return [];
  if (!userMsg || !userMsg.content || !userMsg.content.trim()) return [];
  if (storage.memory.size >= config.memory.maxItems) return [];

  const useOwn = cfg.providerId && cfg.modelId;
  const p = getProvider(useOwn ? cfg.providerId : conversation.providerId);
  const key = p && providerKeys[p.id];
  if (!key) return [];

  const existing = storage.memory.all();
  const messages = [
    { role: 'system', content: P.memory.extract.system },
    {
      role: 'user',
      content: fill(P.memory.extract.user, {
        memory: existing.length ? memoryList(existing) : P.memory.extract.emptyMemory,
        user: clip(userMsg.content, cfg.maxContextChars),
        assistant: clip(assistantMsg.content || '', cfg.maxContextChars),
      }),
    },
  ];
  const settings = {
    modelId: useOwn ? cfg.modelId : conversation.modelId,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    reasoningEffort: '',
  };

  try {
    const json = serializeBody(p, buildBody(p, settings, messages, false));
    const answer = await complete(p, key, json, AbortSignal.timeout(cfg.timeoutSeconds * 1000));
    const match = /\{[\s\S]*\}/.exec(answer);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    const seen = new Set(existing.map((m) => normalizeFact(m.text)));
    const added = [];
    for (const fact of Array.isArray(parsed.add) ? parsed.add : []) {
      if (added.length >= cfg.maxAddPerTurn || storage.memory.size >= config.memory.maxItems) break;
      if (typeof fact !== 'string') continue;
      const text = fact.trim();
      if (!text || text.length > config.memory.maxItemChars || seen.has(normalizeFact(text))) continue;
      seen.add(normalizeFact(text));
      added.push(await storage.memory.add({ text, source: 'auto', conversationId: conversation.id }));
    }
    return added;
  } catch (err) {
    log('server.log.memoryExtractError', { error: err.message });
    return [];
  }
}

module.exports = { systemPrompt, upstreamMessages, extractMemory, TEXT_KINDS };
