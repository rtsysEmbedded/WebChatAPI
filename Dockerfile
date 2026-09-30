FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# Persistent state (conversations + secrets) lives in /data so it survives
# container rebuilds when a volume is mounted there.
ENV NODE_ENV=production \
    WCA_DATA_DIR=/data \
    WCA_SECRETS_FILE=/data/secrets.json
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
