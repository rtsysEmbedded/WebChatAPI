# Architecture

## Overview

```
Browser (public/)                Node.js server (server/)                 Providers
─────────────────                ────────────────────────                 ─────────
index.html + js/*.js  ── JSON ─▶  index.js  (router, auth gate)
                      ◀─ SSE ──   ├─ auth.js       PIN hash, tokens, lockout
                                  ├─ storage.js    JSON files in data/
                                  ├─ providers.js  ── HTTPS + Bearer key ─▶ /models
                                  │                ◀── SSE (OpenAI format) ─ /chat/completions
                                  ├─ http.js       body parsing, static files, headers
                                  └─ config.js     config.json, i18n, secrets
```

The server is a **proxy with state**: it stores the conversations, adds the API key,
forwards the request to the provider, normalises the provider's stream into a small
event protocol, and saves the answer when the stream ends. The browser never talks to a
provider directly.

Design choices:

- **No framework, no database, no build step.** It uses Node's `http` module and JSON
  files, so it runs on any free host and needs no dependencies on the server side.
- **OpenAI-compatible only.** Clean APIs and OpenRouter both implement it, which covers
  practically every model through one code path. Provider differences (model fields,
  reasoning field names, price units) are handled by configuration, not code.
- **Stateless sessions.** HMAC-signed cookies, so nothing needs to be stored per session.

## Directory layout

```
config/
  config.json            all settings
  i18n/en.json, fa.json  all text (ui / server.log / server.errors / server.cli)
  secrets.json           (git-ignored) PIN hash, session secret, optional keys
server/
  index.js               bootstrap, routes, chat streaming
  config.js              loads JSON config, translations, secrets; t() and log()
  auth.js                scrypt PIN hashing, session tokens, brute-force limiter
  providers.js           model listing and normalisation, SSE parsing, chat streaming
  storage.js             conversation persistence (atomic writes, index)
  http.js                HTTP helpers, static files, security headers
  cli/set-pin.js         `npm run set-pin`
  cli/selftest.js        `npm run check`
public/
  index.html             markup only (text via data-i18n attributes)
  css/app.css            styles, light/dark tokens, RTL-aware layout
  js/i18n.js             translation loader, applies data-i18n*
  js/api.js              fetch wrapper and SSE client
  js/render.js           Markdown → DOMPurify → DOM, code blocks
  js/models.js           model picker dialog
  js/app.js              application state, sidebar, chat, composer
data/                    (git-ignored) index.json + conversations/<uuid>.json
```

## HTTP API

All bodies are JSON. Error responses have the form `{ "error": "<code>", "detail"?: "..." }`;
the UI translates `<code>` via `ui.errors.<code>`.

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/public-config` | Non-secret settings the UI needs (app, ui, chat limits, provider list with `configured` flag). |
| GET | `/api/i18n/:lang` | `{ meta, ui }` for a language. |
| GET | `/api/auth/status` | `{ authenticated, authEnabled, pinConfigured, lockedSeconds }` |
| POST | `/api/auth/login` | `{ pin }` → sets the cookie. `401 invalidPin`, `429 locked` (+`retryAfter` seconds), `503 pinNotConfigured`. |
| POST | `/api/auth/logout` | Clears the cookie. |

### Authenticated

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models[?refresh=1]` | `[{ providerId, providerName, models: Model[], error?, detail? }]` |
| GET | `/api/conversations` | Summaries, pinned first, then newest first. |
| POST | `/api/conversations` | Create. Body: `providerId`, `modelId` (required), `systemPrompt`, `temperature`, `maxTokens`, `reasoningEffort`. |
| GET | `/api/conversations/:id` | Full conversation including messages. |
| PATCH | `/api/conversations/:id` | Update `title`, `providerId`, `modelId`, `systemPrompt`, `temperature`, `maxTokens`, `reasoningEffort`, `pinned`. Other fields are ignored. |
| DELETE | `/api/conversations/:id` | Delete. |
| POST | `/api/conversations/:id/chat` | Send a message and stream the answer (below). |

`Model` = `{ id, name, description, contextLength, inputPrice, outputPrice, vision, reasoning }`.
Prices are USD **per token** (`null` when unknown).

### Chat request

```json
{ "content": "text", "images": ["data:image/png;base64,..."] }
{ "content": "new text", "images": [], "editFromMessageId": "<user message id>" }
{ "regenerate": true }
```

- **Send:** appends a user message.
- **Edit:** removes that user message and everything after it, then appends the new text.
- **Regenerate:** removes trailing assistant messages and answers the last user message
  again.

Validation errors (`emptyMessage`, `invalidImage`, `imageTooLarge`, `tooManyImages`,
`providerKeyMissing`, …) return a normal JSON error **before** the stream starts, and
nothing is stored.

### Chat stream (server → browser)

`Content-Type: text/event-stream`. Every frame is `event: <name>\ndata: <json>\n\n`;
`: ping` comment lines keep the connection alive.

| Event | Data | Meaning |
|-------|------|---------|
| `start` | `{ conversation, messages, assistantId }` | The user message is saved; `messages` is the stored history. |
| `delta` | `{ type: "content" \| "reasoning", text }` | Next piece of answer or reasoning text. |
| `usage` | `{ usage: { prompt_tokens, completion_tokens, ... } }` | Token usage, when the provider sends it. |
| `done` | `{ message, conversation }` | The final assistant message as stored, including `error`, `stopped` and `usage`. |

Provider errors, including error frames sent in the middle of a stream (for example
`data: {"error":{...}}` from Clean APIs), do not break the protocol. They end up in
`message.error` of the `done` event and are stored with the message, so partial output
is kept.

**Stop button:** the browser aborts the fetch. The server sees the connection close,
aborts the upstream request (so the provider can stop generating; whether billing stops at that point depends on the provider), and stores
the partial answer with `stopped: true`.

### Provider side

Request body sent to `<baseUrl><chatPath>`:

```json
{
  "...extraBody": "...",
  "model": "<modelId>",
  "messages": [
    { "role": "system", "content": "<systemPrompt>" },
    { "role": "user", "content": "text" },
    { "role": "user", "content": [ { "type": "text", "text": "..." },
                                   { "type": "image_url", "image_url": { "url": "data:..." } } ] },
    { "role": "assistant", "content": "..." }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 4096,
  "reasoning_effort": "high"
}
```

`temperature`, `max_tokens` and `reasoning_effort` are only sent when set (and
`reasoning_effort` only for providers with `supportsReasoningEffort`). Reasoning text
from earlier turns is **not** sent back to the model.

Stream parsing (`providers.sseJson`) splits on newlines, ignores comment lines (`: ping`,
`: OPENROUTER PROCESSING`), stops at `data: [DONE]`, and tolerates frames split across
network chunks. For each chunk it reads `choices[0].delta.content`, the first non-empty
field from `reasoningFields`, and `usage`.

## Storage format

`data/conversations/<uuid>.json`:

```json
{
  "id": "uuid", "title": "…", "createdAt": "ISO", "updatedAt": "ISO",
  "providerId": "openrouter", "modelId": "anthropic/…",
  "systemPrompt": "", "temperature": 0.7, "maxTokens": null, "reasoningEffort": "",
  "pinned": false,
  "messages": [
    { "id": "uuid", "role": "user", "content": "…", "images": [], "createdAt": "ISO" },
    { "id": "uuid", "role": "assistant", "content": "…", "reasoning": "…",
      "providerId": "…", "modelId": "…", "createdAt": "ISO",
      "usage": { "prompt_tokens": 0, "completion_tokens": 0 }, "error": null, "stopped": false }
  ]
}
```

`data/index.json` maps id → summary (no messages), so the sidebar never reads full
conversations. The index is rebuilt from the conversation files if it is missing.

All writes go through one promise chain (no concurrent writes) and use
write-temp-then-rename, so files are never left half-written.

Images are stored inline as data URLs, which keeps the format self-contained but makes
conversations with many images large. `chat.maxImageBytes` and
`chat.maxImagesPerMessage` bound the growth.

## Frontend

- Plain ES2020 scripts, loaded with `defer` in dependency order: `i18n` → `api` →
  `render` → `models` → `app`. No bundler.
- Routing: `#/` = new chat, `#/c/<uuid>` = a conversation. A new chat is created on the
  server only when the first message is sent.
- Streaming rendering: incoming deltas are collected and painted at most once per
  animation frame. Markdown is re-parsed on each paint; syntax highlighting runs only once
  the message is complete.
- Per-browser preferences (theme, language, last model) are kept in `localStorage`. All
  real data lives on the server.
