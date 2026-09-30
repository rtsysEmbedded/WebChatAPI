'use strict';

const http = require('http');
const { config, i18n, log, loadSecrets } = require('./config');
const auth = require('./auth');
const storage = require('./storage');
const { providers, getProvider, listModels, streamChat } = require('./providers');
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
  return target;
}

function validateImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images) || images.length > C.maxImagesPerMessage) throw new H.HttpError(400, 'tooManyImages');
  for (const url of images) {
    const m = typeof url === 'string' && /^data:([a-z/+.-]+);base64,/.exec(url);
    if (!m || !C.allowedImageTypes.includes(m[1])) throw new H.HttpError(400, 'invalidImage');
    const bytes = Math.floor(((url.length - m[0].length) * 3) / 4);
    if (bytes > C.maxImageBytes) throw new H.HttpError(400, 'imageTooLarge');
  }
  return images;
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
      maxImageBytes: C.maxImageBytes,
      maxImagesPerMessage: C.maxImagesPerMessage,
      allowedImageTypes: C.allowedImageTypes,
    },
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
  const result = await Promise.all(
    providers.map(async (p) => {
      const key = secrets.providerKeys[p.id];
      if (!key) return { providerId: p.id, providerName: p.name, models: [], error: 'providerKeyMissing' };
      try {
        return { providerId: p.id, providerName: p.name, models: await listModels(p, key, refresh) };
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
// Body: { content, images?, regenerate?, editFromMessageId? }
async function chat(req, res, id) {
  const body = await H.readJsonBody(req);
  const c = await loadConversation(id);
  const { p, key } = requireProvider(c.providerId);
  if (!c.modelId) throw new H.HttpError(400, 'modelRequired');

  if (body.regenerate) {
    while (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
    if (!c.messages.length) throw new H.HttpError(400, 'nothingToRegenerate');
  } else {
    const content = typeof body.content === 'string' ? body.content : '';
    const images = validateImages(body.images);
    if (!content.trim() && !images.length) throw new H.HttpError(400, 'emptyMessage');
    if (body.editFromMessageId) {
      const idx = c.messages.findIndex((m) => m.id === body.editFromMessageId);
      if (idx < 0 || c.messages[idx].role !== 'user') throw new H.HttpError(400, 'notFound');
      c.messages = c.messages.slice(0, idx);
    }
    c.messages.push({ id: storage.newId(), role: 'user', content, images, createdAt: now() });
  }
  if (!c.title) c.title = makeTitle(c.messages.find((m) => m.role === 'user').content);
  await storage.save(c);

  const assistant = {
    id: storage.newId(),
    role: 'assistant',
    content: '',
    reasoning: '',
    providerId: p.id,
    modelId: c.modelId,
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
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { conversation: { ...c, messages: undefined }, messages: c.messages, assistantId: assistant.id });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), C.upstreamTimeoutSeconds * 1000);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), config.server.sseKeepAliveSeconds * 1000);
  res.on('close', () => {
    if (!res.writableEnded) {
      assistant.stopped = true;
      controller.abort();
    }
  });

  try {
    for await (const ev of streamChat(p, key, c, c.messages, controller.signal)) {
      if (ev.type === 'content') assistant.content += ev.text;
      else if (ev.type === 'reasoning') assistant.reasoning += ev.text;
      else if (ev.type === 'usage') assistant.usage = ev.usage;
      if (!res.writableEnded) send(ev.type === 'usage' ? 'usage' : 'delta', ev);
    }
  } catch (err) {
    if (!assistant.stopped) {
      assistant.error = err.message;
      log('server.log.chatError', { provider: p.id, model: c.modelId, error: err.message });
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(keepAlive);
  }

  c.messages.push(assistant);
  await storage.save(c);
  if (!res.writableEnded) {
    send('done', { message: assistant, conversation: { ...c, messages: undefined } });
    res.end();
  }
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

  if (method === 'GET' && path === '/api/models') return models(req, res, url);
  if (method === 'GET' && path === '/api/conversations') return H.sendJson(res, 200, storage.list());
  if (method === 'POST' && path === '/api/conversations') return createConversation(req, res);

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
