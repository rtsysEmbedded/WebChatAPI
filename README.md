# WebChatAPI

A self-hosted, ChatGPT-style web interface for **OpenAI-compatible API providers**.
It ships pre-configured for [Clean APIs](https://cleanapis.com/docs/getting-started) and
[OpenRouter](https://openrouter.ai), and lets you pick **any model** each provider exposes.
Access is protected by a **PIN**.

It is a single small Node.js process with no database and no build step, so it runs on
free-tier hosts (a free VM, Docker hosts, PaaS free plans) and on a Raspberry Pi.

## Features

- ChatGPT-like UI: conversation sidebar (search, pin, rename, delete), streaming answers,
  stop / regenerate / edit-and-resend, copy buttons, Markdown with syntax-highlighted code.
- Model picker listing every model from every configured provider, with search,
  provider tabs, context size, price per 1M tokens, and vision / reasoning badges.
- Reasoning ("thinking") output shown in a collapsible block (Clean APIs
  `reasoning_content`, OpenRouter `reasoning`).
- Image input (paste, drag & drop, or attach) for vision models.
- Per-chat system prompt, temperature, max tokens and reasoning effort.
- PIN login with scrypt hashing, signed HttpOnly session cookie, per-IP **and** global
  brute-force lockout.
- API keys never leave the server; the browser talks only to your instance.
- English and Persian UI (RTL); dark / light / system theme; mobile layout.
- **Everything configurable in JSON** (`config/config.json`, `config/i18n/*.json`) — no
  settings or UI text hardcoded in the code.

## Quick start

Requirements: Node.js ≥ 20.12.

```bash
git clone <this repo> webchatapi && cd webchatapi
npm ci --omit=dev
npm run set-pin                       # choose your PIN (stored as a scrypt hash)
cp .env.example .env                  # put your API keys (and optionally PORT) in .env
npm start                             # http://localhost:3000
```

With Docker:

```bash
cp .env.example .env    # fill in keys and WCA_PIN
docker compose up -d --build
```

## Documentation

| Document | Content |
|----------|---------|
| [docs/installation.md](docs/installation.md) | Local install, PIN setup, API keys, updating |
| [docs/configuration.md](docs/configuration.md) | Every key in `config.json`, secrets, adding providers, translations |
| [docs/deployment.md](docs/deployment.md) | Docker, free VM with HTTPS (Caddy + systemd), PaaS hosts |
| [docs/security.md](docs/security.md) | Threat model, PIN/session design, hardening checklist |
| [docs/architecture.md](docs/architecture.md) | Code layout, HTTP API, streaming protocol, storage format |

## License

MIT — see [LICENSE](LICENSE).
