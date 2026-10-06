# syntax=docker/dockerfile:1

# Override with --build-arg NODE_IMAGE=... (e.g. a registry mirror when Docker Hub
# rate-limits anonymous pulls). The app needs Node.js >= 22.13 (built-in node:sqlite).
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# Persistent state lives in /data and survives rebuilds when a volume is mounted:
# conversations, uploads, memory, settings.json and secrets.json (PIN hash, session
# secret and the API keys saved from the settings panel).
ENV NODE_ENV=production \
    WCA_DATA_DIR=/data \
    WCA_SECRETS_FILE=/data/secrets.json \
    HOST=0.0.0.0 \
    PORT=3000
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

# /api/auth/status needs no login and answers 200 whenever the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
