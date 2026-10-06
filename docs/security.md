# Security

WebChatAPI is designed for **one owner** (or a small trusted group sharing one PIN) on a
public server. This document describes what is protected, how, and where the limits are.

## Threat model

| Asset | Threat | Mitigation |
|-------|--------|------------|
| Provider API keys (they cost money) | Theft through the browser, logs or the repo | Keys stay server-side; the browser never receives them. They come from env vars or a git-ignored file and are never logged. |
| Access to the app | PIN guessing | scrypt hash, per-IP and global lockout, fixed delay per failure |
| Session | Theft, forgery, cross-site use | HMAC-signed HttpOnly `SameSite=Strict` cookie, `Secure` on HTTPS, Origin check |
| Chat history | Read by others | All `/api` routes except login/status require a session; data lives only on your server |
| Browser | XSS through model output | Markdown sanitised with DOMPurify; strict CSP without inline scripts |

Out of scope: multi-user separation (everyone with the PIN sees all chats), protection
against someone with shell access to the server, and the providers' own data handling.

## PIN storage

- `npm run set-pin` stores `scrypt$N$r$p$salt$hash` (N=16384, r=8, p=1, 64-byte key,
  16-byte random salt). The parameters are stored with the hash, so they can be raised
  in `config.json` for new hashes without breaking existing ones.
- Verification uses `crypto.timingSafeEqual`.
- `WCA_PIN` (plain PIN in an env var) is supported for hosts without a shell. It is hashed
  in memory at start-up. Prefer `WCA_PIN_HASH`, because a hash in the host's settings
  page is less sensitive than the PIN itself.

## Brute-force protection

A 4-digit PIN has 10,000 combinations and a 6-digit PIN has 1,000,000, so rate limiting
is what makes a PIN viable. Hashing alone is not enough.

With the defaults (5 failures per IP per 15 min, 30 global failures per 15 min, 15-min
lockout):

- One IP can try at most about 5 PINs per 15 minutes (≈ 480 per day).
- **All attackers together** can try at most about 30 PINs per 15 minutes
  (≈ 2,880 per day), because the global limit locks login for everyone.
  - 4-digit PIN: the whole space can be exhausted in about 3.5 days of sustained attack.
  - 6-digit PIN: about 347 days for the whole space, so a 50 % chance takes roughly
    half a year.
  - 8-digit PIN: about 95 years for the whole space.

**Recommendation: use at least 6 digits, preferably 8, on a public server.** Raise
`auth.pinMinLength` to enforce it.

Trade-off: an attacker can keep the global lock active and deny you login (DoS). If that
happens, you can raise `maxFailedAttemptsGlobal` or restrict access at the network level
(firewall allow-list, VPN such as Tailscale/WireGuard, or Cloudflare Access).

Lockout counters live in memory and reset on restart.

## Client IP and proxies

The per-IP limit needs the real client IP. With `server.trustedProxyHops = N`, the app
takes the **N-th entry from the right** of `X-Forwarded-For`. Entries further left are
supplied by the client and can be forged, so they are never used.

- Behind exactly one proxy (Caddy, nginx, most PaaS edges): `1` (default).
- Exposed directly without a proxy: **set `0`**. Otherwise an attacker can send a fake
  `X-Forwarded-For` header on every request, and each one counts as a new IP. The
  global limit still applies in that case.

## Sessions

- Token = `base64url(payload) "." HMAC-SHA256(payload, sessionSecret)`, where the payload
  holds `iat`, `exp` and a PIN fingerprint.
- The fingerprint is an **HMAC keyed with the session secret** over the PIN credential. It
  is not a plain hash, because a plain hash of a short PIN could be reversed by trying all
  PINs. Changing the PIN therefore invalidates every session at once.
- Rotating the session secret (delete it from the secrets file or change
  `WCA_SESSION_SECRET`) also logs everyone out.
- The cookie is `HttpOnly` (JavaScript cannot read it) and `SameSite=Strict` (it is not
  sent on cross-site requests). It gets the `Secure` flag when the request came over
  HTTPS.
- Sessions are stateless. Logging out clears the cookie in that browser, but a stolen
  token stays valid until it expires (`sessionTtlHours`) or the PIN or secret changes.
- Sessions use sliding expiry (`sessionRenewAfterHours`): each token is re-issued while in
  use, so a stolen token that is kept in use also stays valid. Changing the PIN or the
  session secret revokes all tokens. Set `sessionRenewAfterHours` to `0` for a fixed
  lifetime.

## Cross-site request forgery

Besides `SameSite=Strict`, every non-GET API request is rejected when its `Origin` header
names a different host. Request bodies must be `application/json`, which a plain HTML form
on another site cannot send without a CORS preflight. CORS is not enabled.

## Content Security Policy and XSS

Model output is untrusted. It is parsed as Markdown, sanitised with DOMPurify, and only
then inserted into the page. The default CSP:

```
default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self';
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
```

- No inline or third-party scripts. All libraries are served from your own server
  (`/vendor/...`), with no CDN.
- Remote images in model output are blocked (`img-src` does not allow other hosts). This
  also prevents data exfiltration through image URLs placed in the output by prompt
  injection.
- `frame-ancestors 'none'` and `X-Frame-Options: DENY` prevent clickjacking.

## Uploads

- Only logged-in users can upload or download. Uploads are raw request bodies with a
  per-kind size limit enforced **while streaming** to disk, so a false or missing
  `Content-Length` cannot bypass it.
- Allowed types are an allow-list (`attachments.kinds`). Text files containing NUL bytes
  are rejected as binary. File names are reduced to their base name, with control
  characters removed.
- Files are stored under random UUIDs and never under the uploaded name, so there is no
  path traversal through file names.
- Served back with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.
  Only images and videos are served inline; everything else is `Content-Disposition:
  attachment` with `application/octet-stream`, so an uploaded HTML or SVG file can never
  run as a page on your origin.
- Document parsing (`pdfjs-dist` with `isEvalSupported: false`, `mammoth`) runs on the
  server. Keep dependencies updated (`npm update`, `npm audit`), because parsers are
  the most exposed code.

## Memory and prompt injection

Automatic memory extraction lets a model write to memory. Text that you paste or attach
(web pages, documents) could contain instructions that trick the extractor into storing
false “facts”, which then affect all future chats. Review the memory list (entries are
marked **auto**) now and then, or disable `memory.autoExtract.enabled`.

## Static files

Static files are served only from `public/` (after resolving the path, it must stay inside
that directory) and from the fixed `vendorFiles` list. `config/`, `data/` and the secrets
file cannot be reached over HTTP.

## Hardening checklist

- [ ] HTTPS in front of the app (see [deployment.md](deployment.md)).
- [ ] PIN of at least 6–8 digits; `auth.pinMinLength` raised accordingly.
- [ ] `server.trustedProxyHops` matches your setup (`0` when exposed directly).
- [ ] App bound to `127.0.0.1` when a local reverse proxy is used.
- [ ] Secrets file mode `600` (set automatically when the app creates it).
- [ ] Spending limits or prepaid credit in the provider dashboards, where the provider
      supports it (OpenRouter supports per-key credit limits), so a compromise has a
      bounded cost.
- [ ] Backups of `data/` if the history matters to you.
- [ ] Optional: network allow-list or VPN for an extra layer.
