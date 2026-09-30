'use strict';

const crypto = require('crypto');
const { config } = require('./config');

const A = config.auth;

// ---- PIN hashing (scrypt) -------------------------------------------------
// Format: scrypt$N$r$p$saltB64$hashB64 — parameters travel with the hash so
// they can be raised later without invalidating existing hashes.

function scryptAsync(pin, salt, keyLength, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, keyLength, { ...opts, maxmem: 256 * opts.N * opts.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

async function hashPin(pin) {
  const { N, r, p, keyLength, saltBytes } = A.scrypt;
  const salt = crypto.randomBytes(saltBytes);
  const key = await scryptAsync(pin, salt, keyLength, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPin(pin, stored) {
  if (!stored || typeof pin !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scryptAsync(pin, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function validatePinFormat(pin) {
  return (
    typeof pin === 'string' &&
    pin.length >= A.pinMinLength &&
    pin.length <= A.pinMaxLength &&
    new RegExp(A.pinPattern).test(pin)
  );
}

// ---- Session tokens (stateless, HMAC-SHA256) -----------------------------
// The token embeds a keyed fingerprint of the PIN credential, so changing the
// PIN invalidates every existing session. It is an HMAC (not a plain hash) so
// the readable token payload reveals nothing about a low-entropy PIN.

function fingerprint(secrets) {
  const source = secrets.pin ? `pin:${secrets.pin}` : `hash:${secrets.pinHash || ''}`;
  return crypto.createHmac('sha256', secrets.sessionSecret).update(source).digest('base64url').slice(0, 16);
}

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function createToken(secrets) {
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({ iat: now, exp: now + A.sessionTtlHours * 3600e3, fp: fingerprint(secrets) }),
  ).toString('base64url');
  return `${payload}.${sign(payload, secrets.sessionSecret)}`;
}

function verifyToken(token, secrets) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = Buffer.from(sign(payload, secrets.sessionSecret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() && data.fp === fingerprint(secrets);
  } catch {
    return false;
  }
}

// ---- Brute-force protection ----------------------------------------------
// A PIN has low entropy, so attempts are limited per client IP *and* globally
// (the global limit defends against attackers rotating IP addresses).

const attempts = new Map(); // ip -> { times: number[], lockedUntil }
const globalState = { times: [], lockedUntil: 0 };

function prune(times, now) {
  const windowMs = A.attemptWindowMinutes * 60e3;
  while (times.length && now - times[0] > windowMs) times.shift();
}

function lockStatus(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  const until = Math.max(globalState.lockedUntil, entry ? entry.lockedUntil : 0);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { times: [], lockedUntil: 0 };
  entry.times.push(now);
  prune(entry.times, now);
  if (entry.times.length >= A.maxFailedAttemptsPerIp) {
    entry.lockedUntil = now + A.lockoutMinutes * 60e3;
    entry.times = [];
  }
  attempts.set(ip, entry);

  globalState.times.push(now);
  prune(globalState.times, now);
  if (globalState.times.length >= A.maxFailedAttemptsGlobal) {
    globalState.lockedUntil = now + A.lockoutMinutes * 60e3;
    globalState.times = [];
  }
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

// Periodic cleanup so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of attempts) {
    prune(e.times, now);
    if (!e.times.length && e.lockedUntil < now) attempts.delete(ip);
  }
}, 60e3).unref();

module.exports = {
  hashPin,
  verifyPin,
  validatePinFormat,
  createToken,
  verifyToken,
  lockStatus,
  recordFailure,
  recordSuccess,
};
