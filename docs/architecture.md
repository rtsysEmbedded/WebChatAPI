# Architecture

## Overview

```
Browser (public/)                Node.js server (server/)                 Providers
─────────────────                ────────────────────────                 ─────────
index.html + js/*.js  ── JSON ─▶  index.js  (router, auth gate)
                      ◀─ SSE ──   ├─ auth.js       PIN hash, tokens, lockout
                                  ├─ storage.js    JSON files in data/ (chats, uploads, memory, characters)
                                  ├─ context.js    system prompt, memory, attachments → upstream messages
                                  ├─ features.js   uploads, memory and character endpoints
                                  ├─ extract.js    PDF / DOCX / text extraction
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
  prompts.json           all text sent to models (memory block, extraction, file wrapper)
  secrets.json           (git-ignored) PIN hash, session secret, optional keys
server/
  index.js               bootstrap, routes, chat streaming
  config.js              loads JSON config, translations, secrets; t() and log()
  auth.js                scrypt PIN hashing, session tokens, brute-force limiter
  providers.js           model listing and normalisation, request building, SSE parsing
  context.js             system prompt assembly, attachments, memory extraction
  features.js            uploads, memory and character HTTP handlers
  extract.js             text extraction (pdfjs-dist, mammoth)
  storage.js             persistence (atomic writes, index, uploads, list stores)
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
  js/app.js              application state, sidebar, chat, composer, attachments
  js/features.js         memory manager and character editor dialogs
data/                    (git-ignored) index.json, conversations/, uploads/, memory.json, characters.json
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
| PATCH | `/api/conversations/:id` | Update `title`, `providerId`, `modelId`, `systemPrompt`, `temperature`, `maxTokens`, `reasoningEffort`, `pinned`, `characterId`, `useMemory`. Other fields are ignored. |
| DELETE | `/api/conversations/:id` | Delete. |
| POST | `/api/conversations/:id/chat` | Send a message and stream the answer (below). |
| POST | `/api/uploads` | Upload one file. Raw body; headers `Content-Type` and `X-File-Name` (URI-encoded). Returns `{ id, name, mime, kind, size, textChars, truncated, pages, conversationId: null }`. Errors: `unsupportedFile` (415), `fileTooLarge` (413), `emptyFile`, `extractFailed` (422). |
| GET | `/api/uploads/:id` | The file. Images and videos inline (with `Range` support), documents as a download. |
| DELETE | `/api/uploads/:id` | Delete an upload that is not yet part of a sent message (`409 uploadInUse` otherwise). |
| GET / POST / DELETE | `/api/memory` | List `{ items }`; add `{ text }`; clear all. |
| PATCH / DELETE | `/api/memory/:id` | Edit `{ text }`; delete. |
| GET / POST | `/api/characters` | List `{ items }`; create `{ name, avatar, description, systemPrompt, providerId, modelId, temperature, useMemory }`. |
| PATCH / DELETE | `/api/characters/:id` | Update (same fields); delete. |

`Model` = `{ id, name, description, contextLength, inputPrice, outputPrice, vision, reasoning }`.
Prices are USD **per token** (`null` when unknown).

### Chat request

```json
{ "content": "text", "attachments": ["<upload id>", "..."] }
{ "content": "new text", "attachments": [], "editFromMessageId": "<user message id>" }
{ "regenerate": true }
```

- **Send:** appends a user message.
- **Edit:** removes that user message and everything after it, then appends the new text.
- **Regenerate:** removes trailing assistant messages and answers the last user message
  again.

Validation errors (`emptyMessage`, `invalidFile`, `tooManyFiles`, `providerKeyMissing`,
`requestTooLarge`, …) return a normal JSON error **before** the stream starts, and nothing
is stored. The full upstream request is built and size-checked before the user message
is saved.

### Chat stream (server → browser)

`Content-Type: text/event-stream`. Every frame is `event: <name>\ndata: <json>\n\n`;
`: ping` comment lines keep the connection alive.

| Event | Data | Meaning |
|-------|------|---------|
| `start` | `{ conversation, messages, assistantId }` | The user message is saved; `messages` is the stored history. |
| `delta` | `{ type: "content" \| "reasoning", text }` | Next piece of answer or reasoning text. |
| `usage` | `{ usage: { prompt_tokens, completion_tokens, ... } }` | Token usage, when the provider sends it. |
| `done` | `{ message, conversation }` | The final assistant message as stored, including `error`, `stopped` and `usage`. The answer is complete; the UI finishes here. |
| `memory` | `{ added: [...], removed: [...], error: string \| null }` | Optional, after `done`: result of automatic memory extraction (sent only when something changed or it failed). The stream then ends. |

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

User messages with attachments: document text (PDF/DOCX/text) is prepended to the
message text as `<attached_file name="…">…</attached_file>` blocks. Images become
`{ "type": "image_url", "image_url": { "url": "data:…" } }` parts and videos
`{ "type": "video_url", "video_url": { "url": "data:…" } }` parts. Without media parts
the content stays a plain string, for maximum provider compatibility. The system prompt
is `character.systemPrompt`, `conversation.systemPrompt` and the memory block, joined by
`prompts.systemJoiner`, with empty parts omitted.

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
  "pinned": false, "characterId": null, "useMemory": true,
  "messages": [
    { "id": "uuid", "role": "user", "content": "…", "createdAt": "ISO",
      "attachments": [ { "id": "uuid", "name": "a.pdf", "kind": "pdf", "mime": "application/pdf", "size": 1234, "truncated": false } ] },
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

Uploads live in `data/uploads/`: `<id>.bin` (original bytes), `<id>.json` (metadata including
`conversationId`), and `<id>.txt` (extracted text, documents only). Messages store only
references. Conversations from before uploads existed may contain inline `images` (data
URLs); they are still rendered and sent.

`data/memory.json` and `data/characters.json` are `{ "items": [...] }` lists written
through the same serialized, atomic write queue.

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
