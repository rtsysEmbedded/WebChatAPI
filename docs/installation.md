# Installation

## Requirements

- **Node.js 20 or newer** (uses the built-in `fetch`, Web Streams and `crypto.randomUUID`).
- An API key for at least one provider:
  - Clean APIs: keys look like `cc_` + 48 characters. See <https://cleanapis.com/docs/authentication>.
  - OpenRouter: keys look like `sk-or-...`. Create one at <https://openrouter.ai/keys>.
- About 50 MB of disk space and very little RAM (measured idle RSS: roughly 50–75 MB on Node.js 22).

## 1. Get the code and install dependencies

```bash
git clone <repository-url> webchatapi
cd webchatapi
npm ci --omit=dev
```

The only runtime dependencies are three browser libraries served locally to the UI:
`marked` (Markdown), `dompurify` (HTML sanitising) and `@highlightjs/cdn-assets`
(code highlighting). The server itself uses only Node.js built-ins.

## 2. Set the PIN

```bash
npm run set-pin
```

You are asked for the PIN twice (input is masked). A scrypt hash is written to the
secrets file (`config/secrets.json` by default, git-ignored). The plain PIN is never stored.

Non-interactive alternative (e.g. in a provisioning script):

```bash
echo 482913 | npm run set-pin
```

PIN rules come from `auth.pinMinLength`, `auth.pinMaxLength` and `auth.pinPattern` in
`config/config.json` (default: 4–32 digits). **Use at least 6 digits** on an
internet-facing server; see [security.md](security.md).

Alternatives when you cannot run a command on the host (typical on PaaS):

| Variable | Meaning |
|----------|---------|
| `WCA_PIN_HASH` | A hash produced by `npm run set-pin` (copy it from the secrets file). Preferred. |
| `WCA_PIN` | The plain PIN; hashed in memory at start-up. Simpler, but the PIN sits in the host's env settings. |

Precedence: `WCA_PIN_HASH` → `pinHash` in the secrets file → `WCA_PIN`.

## 3. Provide API keys

Either as environment variables (names are configured per provider via `apiKeyEnv`):

```bash
export CLEANAPIS_API_KEY=cc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export OPENROUTER_API_KEY=sk-or-xxxxxxxx
```

or in the secrets file (see `config/secrets.example.json`):

```json
{
  "pinHash": "scrypt$16384$8$1$...",
  "providers": {
    "cleanapis": { "apiKey": "cc_..." },
    "openrouter": { "apiKey": "sk-or-..." }
  }
}
```

Environment variables take precedence over the file. A provider without a key still
appears in the model picker, with a message that its key is missing.

## 4. Start

```bash
npm start
```

Open <http://localhost:3000> and enter your PIN. Port and bind address come from
`server.port` / `server.host`, overridable with the `PORT` / `HOST` environment variables
(most PaaS hosts set `PORT` automatically).

On first start, a random session secret is generated and saved to the secrets file so
logins survive restarts. If the file is not writable, set `WCA_SESSION_SECRET` (any long
random string, e.g. `openssl rand -hex 32`).

## 5. Verify

```bash
npm run check
```

Runs a syntax check plus offline self-tests: translation files contain the same keys,
PIN hashing, session-token validation, model-field mapping for both providers, and SSE
parsing.

## Updating

```bash
git pull
npm ci --omit=dev
# restart the process / container
```

Your data (`data/`) and secrets (`config/secrets.json`) are git-ignored and are not
touched by an update. If you changed `config/config.json`, resolve any merge conflicts
in it after `git pull`.

## Changing or resetting the PIN

Run `npm run set-pin` again and restart. All existing sessions become invalid immediately,
because each session token carries a keyed fingerprint of the PIN credential.

## Backups

Everything worth keeping is in two places:

- `data/` (or `WCA_DATA_DIR`): `index.json` + `conversations/<uuid>.json`
- the secrets file

Copy them while the server is running; writes are atomic (temp file + rename), so a copy
never contains a half-written file.
