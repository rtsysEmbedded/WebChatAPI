'use strict';

const fs = require('fs');
const path = require('path');
const { config, resolvePath } = require('./config');

const S = config.server;
const publicDir = resolvePath(S.publicDir);

class HttpError extends Error {
  constructor(status, code, detail) {
    super(detail || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(S.securityHeaders)) res.setHeader(k, v);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': S.mimeTypes['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, err) {
  const status = err.status || 500;
  sendJson(res, status, { error: err.code || 'internal', detail: err.detail || (status === 500 ? undefined : err.message) });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    if (!type.startsWith('application/json')) return reject(new HttpError(415, 'unsupportedMediaType'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > S.maxJsonBodyBytes) {
        reject(new HttpError(413, 'payloadTooLarge'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'invalidJson'));
      }
    });
    req.on('error', reject);
  });
}

// With N trusted proxies in front, the real client address is the N-th entry
// from the right of X-Forwarded-For. Entries further left are client-supplied
// and must not be trusted.
function clientIp(req) {
  const hops = S.trustedProxyHops;
  const xff = req.headers['x-forwarded-for'];
  if (hops > 0 && xff) {
    const list = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length >= hops) return list[list.length - hops];
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSecureRequest(req) {
  return !!req.socket.encrypted || (S.trustedProxyHops > 0 && req.headers['x-forwarded-proto'] === 'https');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Mutating requests must come from our own origin (defence in depth on top
// of the SameSite=Strict cookie).
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function serveFile(res, file, cacheSeconds) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end();
    }
    const type = S.mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, pathname) {
  if (S.vendorFiles[pathname]) return serveFile(res, resolvePath(S.vendorFiles[pathname]), S.staticCacheSeconds);
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  // Own files are revalidated on every load so UI updates show up immediately;
  // only the versioned vendor libraries above are cached.
  return serveFile(res, file, 0);
}

module.exports = {
  HttpError,
  applySecurityHeaders,
  sendJson,
  sendError,
  readJsonBody,
  clientIp,
  isSecureRequest,
  parseCookies,
  checkOrigin,
  serveStatic,
};
