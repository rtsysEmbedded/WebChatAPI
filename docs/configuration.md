# Configuration

All behaviour is driven by JSON files. No setting and no user-visible text is hardcoded
in the source.

| File | Purpose | In git? |
|------|---------|---------|
| `config/config.json` | Server, auth, chat, UI and provider settings | yes |
| `config/i18n/<lang>.json` | All UI text, server log lines, CLI messages | yes |
| `config/secrets.json` | PIN hash, session secret, optional API keys | **no** (git-ignored) |
| `config/secrets.example.json` | Template for the secrets file | yes |
| `.env` | Environment variables (API keys, `PORT`, PIN) for `npm start` and `docker compose` | **no** |

`config.json` is read once at start-up. **Restart the server after changing it.**

---

## `app`

| Key | Default | Description |
|-----|---------|-------------|
| `name` | `"WebChatAPI"` | Shown in the browser tab and on the login screen. |
| `defaultLanguage` | `"en"` | UI language for new visitors, and the fallback when a string is missing. |
| `languages` | `["en","fa"]` | Enabled languages. Each needs `config/i18n/<code>.json`. |
| `serverLogLanguage` | `"en"` | Language of console log lines and CLI output. |

## `server`

| Key | Default | Description |
|-----|---------|-------------|
| `host` / `hostEnv` | `"0.0.0.0"` / `"HOST"` | Bind address; the env var named by `hostEnv` overrides it. Use `127.0.0.1` behind a local reverse proxy. |
| `port` / `portEnv` | `3000` / `"PORT"` | Listen port; the env var overrides it. |
| `trustedProxyHops` | `1` | Number of reverse proxies in front of the app. Controls how the client IP (for login rate limiting) and HTTPS detection are derived from `X-Forwarded-For` / `X-Forwarded-Proto`. **Set to `0` when the app is exposed directly**, otherwise a client could spoof its IP. See [security.md](security.md#client-ip-and-proxies). |
| `sseKeepAliveSeconds` | `15` | Interval of `: ping` comments on the chat stream so proxies do not close idle connections. |
| `maxJsonBodyBytes` | `26214400` (25 MB) | Maximum request body. Must be large enough for images (base64 adds about 33 %). |
| `publicDir` | `"public"` | Static UI files. |
| `dataDir` / `dataDirEnv` | `"data"` / `"WCA_DATA_DIR"` | Conversation storage; the env var overrides it (the Docker image uses `/data`). |
| `vendorFiles` | map | URL path → file in `node_modules` for the browser libraries. |
| `staticCacheSeconds` | `3600` | `Cache-Control` max-age for vendor files. Own UI files are always revalidated. |
| `securityHeaders` | map | Headers added to every response (CSP, `X-Frame-Options`, …). |
| `mimeTypes` | map | File extension → `Content-Type` for static files. |

## `auth`

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | `false` disables the PIN entirely. Only do this on a private network. |
| `pinMinLength` / `pinMaxLength` | `4` / `32` | Accepted PIN length. |
| `pinPattern` | `"^[0-9]+$"` | Regular expression the PIN must match. Change to e.g. `"^.+$"` to allow passphrases. |
| `sessionCookieName` | `"wca_session"` | Name of the session cookie. |
| `sessionTtlHours` | `168` | Session lifetime (7 days). |
| `secureCookie` | `"auto"` | `"auto"`: set the `Secure` flag when the request arrived over HTTPS (directly or via a trusted proxy). `true` / `false` force it. |
| `maxFailedAttemptsPerIp` | `5` | Failed logins per IP within the window before that IP is locked. |
| `maxFailedAttemptsGlobal` | `30` | Failed logins from **all** IPs within the window before login is locked for everyone. Protects against distributed guessing. |
| `attemptWindowMinutes` | `15` | Sliding window for counting failures. |
| `lockoutMinutes` | `15` | Lock duration. |
| `failedLoginDelayMs` | `800` | Extra delay on every wrong PIN. |
| `scrypt` | `N=16384, r=8, p=1, keyLength=64, saltBytes=16` | Parameters for **new** PIN hashes. Existing hashes store their own parameters and keep working. |

## `secrets`

| Key | Default | Description |
|-----|---------|-------------|
| `file` / `fileEnv` | `"config/secrets.json"` / `"WCA_SECRETS_FILE"` | Location of the secrets file. |
| `envFile` | `".env"` | Env file loaded into `process.env` at start-up (relative paths are resolved from the project root). Existing environment variables are not overridden; a missing file is ignored. Set to `null` to disable. |
| `env.pin` | `"WCA_PIN"` | Env var holding a plain PIN. |
| `env.pinHash` | `"WCA_PIN_HASH"` | Env var holding a PIN hash. |
| `env.sessionSecret` | `"WCA_SESSION_SECRET"` | Env var holding the session signing secret. |
| `autoGenerateSessionSecret` | `true` | Generate and persist a secret when none is configured. |

Secrets file format:

```json
{
  "pinHash": "scrypt$16384$8$1$<salt-b64>$<hash-b64>",
  "sessionSecret": "<hex>",
  "providers": { "<providerId>": { "apiKey": "..." } }
}
```

## `chat`

| Key | Default | Description |
|-----|---------|-------------|
| `defaultTemperature` | `0.7` | Temperature for new chats. `null` = do not send (provider default). |
| `temperatureMin` / `temperatureMax` / `temperatureStep` | `0` / `2` / `0.1` | Slider range; the server clamps values to it. |
| `defaultMaxTokens` | `null` | `max_tokens` for new chats; `null` = not sent. |
| `defaultSystemPrompt` | `""` | System prompt for new chats. |
| `reasoningEfforts` | `["", "low", "medium", "high"]` | Options for `reasoning_effort` (`""` = not sent). Labels come from `ui.settings.effort.*`. |
| `titleMaxLength` | `60` | Length of the auto-generated chat title (first user message). |
| `upstreamTimeoutSeconds` | `3600` | Hard limit per streamed answer. |
| `maxImageBytes` | `5242880` | Maximum size per image (5 MB). |
| `maxImagesPerMessage` | `4` | Maximum images per message. |
| `allowedImageTypes` | png, jpeg, webp, gif | Accepted MIME types. |

## `ui`

| Key | Default | Description |
|-----|---------|-------------|
| `defaultTheme` | `"system"` | `system`, `light` or `dark`. Users can override it per browser. |
| `pricePerTokens` | `1000000` | Model prices are shown per this many tokens. |
| `priceCurrencySymbol` / `priceDecimals` | `"$"` / `2` | Price formatting. |
| `sendOnEnter` | `true` | Enter sends; Shift+Enter inserts a newline. |
| `showModelDescriptions` | `true` | Show descriptions in the model picker. |
| `maxModelResults` | `1000` | Maximum number of rows rendered in the model picker at once. |

---

## `providers`

Each entry is an **OpenAI-compatible** endpoint. Any service that implements
`GET /models` and `POST /chat/completions` with SSE streaming works, including OpenAI,
Groq, Together, DeepSeek, Mistral, a local Ollama (`http://localhost:11434/v1`), LM Studio
and vLLM.

| Key | Description |
|-----|-------------|
| `id` | Unique, stable identifier. Stored in conversations; do not rename it after use. |
| `name` | Display name. |
| `enabled` | `false` hides the provider. |
| `baseUrl` | API root, e.g. `https://cleanapis.com/v1`. |
| `apiKeyEnv` | Env var holding the key (alternatively `providers.<id>.apiKey` in the secrets file). |
| `modelsPath` / `chatPath` | Usually `/models` and `/chat/completions`. |
| `headers` | Extra request headers. OpenRouter uses `X-Title` (and optionally `HTTP-Referer`) for app attribution. |
| `extraBody` | Merged into every chat request body, e.g. `{"include_reasoning": true}` or provider routing options. Values set by the app (model, messages, stream, temperature, …) take precedence. |
| `supportsReasoningEffort` | Show the reasoning-effort setting and send `reasoning_effort`. |
| `minMaxTokens` | Lower bound applied to `max_tokens` when it is sent (Clean APIs enforces 2048 for reasoning models). |
| `modelsCacheMinutes` | How long the model list is cached on the server. The picker's **Refresh** button bypasses the cache. |
| `modelFilter` | `{ "field": "<dot.path>", "allow": [...] }`. Keeps models whose field equals, or for arrays contains, an allowed value. Models without the field are kept. `null` = no filter. |
| `modelFields` | Dot paths that map the provider's model object to the internal shape: `id`, `name`, `description`, `contextLength`, `inputPrice`, `outputPrice`, `capabilities` (array), `inputModalities` (array or `null`). |
| `priceUnitTokens` | How many tokens the provider's price refers to (Clean APIs: `1000`; OpenRouter: `1`). Negative or missing prices are shown as “–”. |
| `visionCapability` | Value in `capabilities` that marks image input (Clean APIs: `"vision"`). Models whose `inputModalities` contains `"image"` are also marked. |
| `reasoningFields` | Fields of a streamed `delta` holding reasoning text, checked in order. |
| `staticModels` | Extra model objects (in the provider's own format) appended to the fetched list, for models the `/models` endpoint does not list. |

### Example: add OpenAI

```json
{
  "id": "openai",
  "name": "OpenAI",
  "enabled": true,
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "modelsPath": "/models",
  "chatPath": "/chat/completions",
  "headers": {},
  "extraBody": {},
  "supportsReasoningEffort": true,
  "minMaxTokens": null,
  "modelsCacheMinutes": 60,
  "modelFilter": null,
  "modelFields": {
    "id": "id", "name": "id", "description": null, "contextLength": null,
    "inputPrice": null, "outputPrice": null, "capabilities": null, "inputModalities": null
  },
  "priceUnitTokens": 1,
  "visionCapability": null,
  "reasoningFields": ["reasoning_content", "reasoning"],
  "staticModels": []
}
```

### Example: local Ollama (no key needed)

Set `"baseUrl": "http://localhost:11434/v1"` and give `apiKeyEnv` any variable name set
to a dummy value (e.g. `OLLAMA_API_KEY=ollama`). The key is required by the app but
ignored by Ollama.

---

## Translations (`config/i18n/<lang>.json`)

```json
{
  "meta": { "name": "English", "dir": "ltr", "locale": "en" },
  "ui":     { "...": "strings shown in the browser" },
  "server": { "log": {}, "errors": {}, "cli": {} }
}
```

- `meta.dir` is `ltr` or `rtl`; it sets `<html dir>` and mirrors the layout.
- `meta.locale` is used for number formatting (e.g. “1M”).
- `{name}` placeholders are filled at runtime.
- `ui.errors.<code>` translates the error codes the API returns.

To add a language, copy `en.json` to `<code>.json`, translate the values, and add the
code to `app.languages` (and a name under `ui.languages` in **every** language file).
`npm run check` fails if the key sets differ between languages.

Message content itself is rendered with `dir="auto"`, so Persian or Arabic text in an
English UI (and vice versa) is aligned correctly per message.
