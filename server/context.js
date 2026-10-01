'use strict';

// Builds what is sent to the model: the system prompt (character + chat
// prompt + long-term memory) and the message list with attachments resolved.
// Also runs the automatic memory extraction after a reply.

const { config, prompts, fill, log, t } = require('./config');
const storage = require('./storage');
const archive = require('./archive');
const { getProvider, buildBody, serializeBody, complete } = require('./providers');

const P = prompts;
const TEXT_KINDS = new Set(['text', 'pdf', 'docx']);

function memoryActive(conversation) {
  return config.memory.enabled && conversation.useMemory !== false;
}

function memoryList(items) {
  return items.map((m) => fill(P.memory.item, { text: m.text })).join('\n');
}

function clipTotal(text, max) {
  return text.length > max ? text.slice(0, max) + P.memory.archive.clipped : text;
}

function formatDate(iso) {
  return iso ? iso.slice(0, 10) : '';
}

// Text used to search the archive: the latest user message(s).
function retrievalQuery(messages) {
  const R = config.memory.archive.retrieval;
  return messages
    .filter((m) => m.role === 'user' && m.content)
    .slice(-R.queryMessages)
    .map((m) => m.content)
    .join('\n')
    .slice(-R.maxQueryChars);
}

// Relevant archive entries as a system-prompt block, within a char budget.
async function archiveBlock(conversation, messages) {
  if (!archive.enabled()) return '';
  const hits = await archive.search(retrievalQuery(messages), { excludeConversationId: conversation.id });
  if (!hits.length) return '';
  let budget = config.memory.archive.retrieval.maxInjectChars;
  const entries = [];
  for (const h of hits) {
    if (budget <= 0) break;
    const entry = fill(P.memory.archive.entry, { title: h.title, date: formatDate(h.updatedAt), text: clipTotal(h.text, budget) });
    budget -= entry.length;
    entries.push(entry);
  }
  return fill(P.memory.archive.block, { entries: entries.join('\n\n') });
}

async function systemPrompt(conversation, messages = []) {
  const parts = [];
  const character = conversation.characterId ? storage.characters.get(conversation.characterId) : null;
  if (character && character.systemPrompt) parts.push(character.systemPrompt);
  if (conversation.systemPrompt) parts.push(conversation.systemPrompt);
  if (memoryActive(conversation)) {
    const items = storage.memory.all();
    if (items.length) parts.push(fill(P.memory.block, { items: memoryList(items) }));
    const retrieved = await archiveBlock(conversation, messages);
    if (retrieved) parts.push(retrieved);
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
  const sys = await systemPrompt(conversation, messages);
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

// Parse the extractor's answer. Models often wrap JSON in code fences or add
// prose around it, so try the whole text first, then every {...} span.
function parseJsonObject(text, keys = ['add', 'remove']) {
  const clean = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    /* fall through */
  }
  for (let i = clean.indexOf('{'); i >= 0; i = clean.indexOf('{', i + 1)) {
    for (let j = clean.lastIndexOf('}'); j > i; j = clean.lastIndexOf('}', j - 1)) {
      try {
        const obj = JSON.parse(clean.slice(i, j + 1));
        if (obj && typeof obj === 'object' && keys.some((k) => k in obj)) return obj;
      } catch {
        /* try a shorter span */
      }
    }
  }
  return null;
}

// Recent messages (oldest first) as plain text for the extractor. The
// extractor needs more than the latest message: users often give the facts
// first and only then say "remember this".
function recentConversation(conversation, cfg) {
  const names = P.memory.extract.roles;
  return conversation.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim())
    .slice(-cfg.contextMessages)
    .map((m) => fill(P.memory.extract.line, { role: names[m.role], text: clip(m.content.trim(), cfg.maxContextChars) }))
    .join('\n\n');
}

// Transcript for the summarizer: newest messages that fit the budget.
function transcript(conversation) {
  const names = P.memory.extract.roles;
  const lines = conversation.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && ((m.content && m.content.trim()) || (m.attachments && m.attachments.length)))
    .map((m) => {
      const files = (m.attachments || []).map((a) => a.name).join(', ');
      const text = (m.content || '').trim() + (files ? ` [${files}]` : '');
      return fill(P.memory.extract.line, { role: names[m.role], text });
    });
  const max = config.memory.archive.maxTranscriptChars;
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > max && kept.length) break;
    kept.unshift(lines[i].slice(-max));
    size += lines[i].length;
  }
  const omitted = lines.length - kept.length;
  return (omitted ? fill(P.memory.summary.omitted, { count: omitted }) + '\n\n' : '') + kept.join('\n\n');
}

// The model configured for a background task (fact extraction, summaries) when
// its provider has an API key; otherwise the conversation's own provider and
// model, so a missing key for the configured provider never breaks the task.
function backgroundModel(cfg, conversation, providerKeys) {
  const own = cfg.providerId && cfg.modelId ? getProvider(cfg.providerId) : null;
  if (own && providerKeys[own.id]) return { p: own, modelId: cfg.modelId };
  return { p: getProvider(conversation.providerId), modelId: conversation.modelId };
}

// Summarize the whole conversation into one archive entry (replacing an
// earlier summary of the same conversation). Throws on failure.
async function summarizeConversation(conversation, providerKeys) {
  if (!archive.enabled()) throw new Error(t('server.errors.archiveDisabled'));
  const S = config.memory.archive.summarizer;
  const { p, modelId } = backgroundModel(S, conversation, providerKeys);
  const key = p && providerKeys[p.id];
  if (!key) throw new Error(t('server.errors.providerKeyMissing', { provider: p ? p.name : '-' }));

  const messages = [
    { role: 'system', content: P.memory.summary.system },
    {
      role: 'user',
      content: fill(P.memory.summary.user, {
        title: conversation.title || '',
        date: formatDate(conversation.updatedAt || new Date().toISOString()),
        transcript: transcript(conversation),
      }),
    },
  ];
  const settings = { modelId, temperature: S.temperature, maxTokens: S.maxTokens, reasoningEffort: '' };
  const json = serializeBody(p, buildBody(p, settings, messages, false));
  const answer = await complete(p, key, json, AbortSignal.timeout(S.timeoutSeconds * 1000));
  const parsed = parseJsonObject(answer, ['title', 'summary']);
  // Fall back to the raw answer when the model ignored the JSON format.
  const title = (parsed && typeof parsed.title === 'string' && parsed.title.trim()) || conversation.title || formatDate(new Date().toISOString());
  const text = (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) || answer.trim();
  if (!text) throw new Error(t('server.errors.memoryParse'));
  return archive.upsertConversation({ conversationId: conversation.id, title: title.slice(0, 200), text });
}

// Update long-term memory from the latest exchange. Returns
// { added: [...], removed: [...], error: string|null }. Never throws.
async function extractMemory(conversation, providerKeys) {
  const cfg = config.memory.autoExtract;
  const result = { added: [], removed: [], saved: null, error: null };
  if (!memoryActive(conversation) || !cfg.enabled) return result;

  const { p, modelId } = backgroundModel(cfg, conversation, providerKeys);
  const key = p && providerKeys[p.id];
  if (!key) return result;

  const excerpt = recentConversation(conversation, cfg);
  if (!excerpt) return result;
  const existing = storage.memory.all();
  const numbered = existing.map((m, i) => fill(P.memory.extract.item, { n: i + 1, text: m.text })).join('\n');
  const messages = [
    { role: 'system', content: P.memory.extract.system },
    {
      role: 'user',
      content: fill(P.memory.extract.user, {
        memory: existing.length ? numbered : P.memory.extract.emptyMemory,
        conversation: excerpt,
      }),
    },
  ];
  const settings = {
    modelId,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    reasoningEffort: '',
  };

  try {
    const json = serializeBody(p, buildBody(p, settings, messages, false));
    const answer = await complete(p, key, json, AbortSignal.timeout(cfg.timeoutSeconds * 1000));
    const parsed = parseJsonObject(answer);
    if (!parsed) {
      log('server.log.memoryExtractParse', { answer: clip(answer, 500) });
      result.error = t('server.errors.memoryParse');
      return result;
    }

    // Removals first (by the 1-based numbers shown to the model), so a
    // corrected fact can replace the outdated one in the same turn.
    const toRemove = (Array.isArray(parsed.remove) ? parsed.remove : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= existing.length)
      .slice(0, cfg.maxRemovePerTurn);
    for (const n of new Set(toRemove)) {
      const item = existing[n - 1];
      if (await storage.memory.remove(item.id)) result.removed.push(item);
    }

    const seen = new Set(storage.memory.all().map((m) => normalizeFact(m.text)));
    for (const fact of Array.isArray(parsed.add) ? parsed.add : []) {
      if (result.added.length >= cfg.maxAddPerTurn || storage.memory.size >= config.memory.maxItems) break;
      if (typeof fact !== 'string') continue;
      const text = fact.trim().slice(0, config.memory.maxItemChars);
      if (!text || seen.has(normalizeFact(text))) continue;
      seen.add(normalizeFact(text));
      result.added.push(await storage.memory.add({ text, source: 'auto', conversationId: conversation.id }));
    }

    // "Remember this conversation" → store a clean summary of the whole chat.
    if (parsed.saveConversation === true && config.memory.archive.summarizeOnRemember && archive.enabled()) {
      const entry = await summarizeConversation(conversation, providerKeys);
      result.saved = { id: entry.id, title: entry.title };
    }
    return result;
  } catch (err) {
    log('server.log.memoryExtractError', { error: err.message });
    result.error = err.message;
    return result;
  }
}

module.exports = { systemPrompt, upstreamMessages, extractMemory, summarizeConversation, backgroundModel, parseJsonObject, transcript, TEXT_KINDS };
