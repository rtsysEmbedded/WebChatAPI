# Deployment

WebChatAPI is one Node.js process that needs:

1. Node.js ≥ 20, **or** a Docker runtime.
2. A few environment variables (API keys, optionally the PIN).
3. A writable directory for conversations. It must be **persistent** if you want chat
   history to survive restarts and redeploys.
4. **HTTPS** in front of it on any public server. The PIN and session cookie must not
   travel over plain HTTP.

Free-tier offers change often. The options below are grouped by what they provide rather
than by vendor promises; check each vendor's current terms before you choose.

| Option | Persistence | HTTPS | Sleeps when idle | Recommended for |
|--------|-------------|-------|------------------|-----------------|
| Free-tier VM (e.g. Oracle Cloud Always Free, Google Cloud e2-micro) + Caddy | yes (disk) | Caddy, automatic | no | **Best overall** |
| Any VPS / home server + Docker Compose | yes (volume) | Caddy / existing proxy | no | Existing servers |
| PaaS free plan running a Dockerfile | often **no** on free plans | provided | often yes | Quick trials |

---

## Option A — Free VM with Caddy and systemd (recommended)

Assumed layout (these steps have not been run on every distribution): Ubuntu 22.04/24.04 or Debian 12, a domain (or free subdomain) pointing to
the VM's public IP, ports 80 and 443 open in the cloud firewall **and** the VM firewall.

### 1. Install Node.js and the app

```bash
sudo apt update && sudo apt install -y ca-certificates curl git
# Node.js 22 from NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo useradd --system --create-home --home-dir /opt/webchatapi --shell /usr/sbin/nologin webchat
sudo -u webchat git clone <repository-url> /opt/webchatapi/app
cd /opt/webchatapi/app
sudo -u webchat npm ci --omit=dev
sudo -u webchat npm run set-pin
```

### 2. Environment file

`/etc/webchatapi.env` (mode `600`, owned by root):

```bash
HOST=127.0.0.1
PORT=3000
CLEANAPIS_API_KEY=cc_...
OPENROUTER_API_KEY=sk-or-...
```

Binding to `127.0.0.1` means only Caddy can reach the app. Keep
`server.trustedProxyHops` at `1` (one proxy: Caddy).

### 3. systemd service

`/etc/systemd/system/webchatapi.service`:

```ini
[Unit]
Description=WebChatAPI
After=network-online.target
Wants=network-online.target

[Service]
User=webchat
WorkingDirectory=/opt/webchatapi/app
EnvironmentFile=/etc/webchatapi.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/webchatapi/app/data /opt/webchatapi/app/config
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webchatapi
journalctl -u webchatapi -f      # logs
```

### 4. Caddy (automatic HTTPS)

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
chat.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

`flush_interval -1` forwards streamed tokens immediately. Caddy normally detects
`text/event-stream` on its own; the setting makes it explicit.

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews a Let's Encrypt certificate automatically. If you have no
domain, free dynamic-DNS services (for example DuckDNS) provide a subdomain.

### nginx instead of Caddy

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;              # required for streaming
    proxy_read_timeout 3600s;
    client_max_body_size 25m;         # >= server.maxJsonBodyBytes
}
```

The app also sends `X-Accel-Buffering: no` on the stream, which disables nginx buffering
for that response.

---

## Option B — Docker Compose

```bash
git clone <repository-url> webchatapi && cd webchatapi
cp .env.example .env         # set the API keys and WCA_PIN (or WCA_PIN_HASH)
docker compose up -d --build
docker compose logs -f
```

- Conversations **and** the secrets file are stored in the named volume `webchatapi-data`
  (`/data` in the container; `WCA_DATA_DIR` and `WCA_SECRETS_FILE` point there).
- To set the PIN as a hash instead of via `.env`:
  `docker compose exec webchatapi npm run set-pin`, then restart.
- Put Caddy or nginx in front for HTTPS as in Option A, or add a Caddy service to the
  compose file.
- The container publishes port 3000 on all interfaces by default. When a proxy on the same
  host terminates TLS, change the mapping to `"127.0.0.1:3000:3000"`.

---

## Option C — PaaS (Render, Koyeb, Railway, Hugging Face Spaces, …)

Most platforms can build the included `Dockerfile` or run `npm start` directly.

1. Create a web service from your fork of the repository (Docker or Node runtime).
2. Set the environment variables: provider keys, `WCA_PIN_HASH` (or `WCA_PIN`), and
   **`WCA_SESSION_SECRET`** (`openssl rand -hex 32`). Without it, a platform with a
   read-only or ephemeral filesystem logs everyone out on every restart.
3. The platform injects `PORT`; nothing else to configure.
4. `server.trustedProxyHops = 1` is right for platforms with a single edge proxy. If the
   platform documents a different number of proxy hops, adjust it.
5. **Persistence:** on free plans the filesystem is usually wiped on each redeploy or
   restart, which deletes chat history. Attach a persistent disk/volume if the plan offers
   one and set `WCA_DATA_DIR` to its mount path; otherwise treat history as temporary.
6. Free services that sleep when idle take several seconds for the first request
   after a pause. Streaming is unaffected once the instance is awake.

Hugging Face Spaces (Docker SDK) expects the app on port **7860**: set the variable
`PORT=7860` in the Space settings. Spaces can be public; the PIN still protects the app.

---

## Health check

`GET /api/auth/status` returns `200` with a small JSON body and needs no authentication.
Use it as the platform's health-check path.

## Upgrading a deployment

- VM: `cd /opt/webchatapi/app && sudo -u webchat git pull && sudo -u webchat npm ci --omit=dev && sudo systemctl restart webchatapi`
- Docker: `git pull && docker compose up -d --build`
- PaaS: push to the connected branch.
