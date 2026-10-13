# Vault — self-hosted media server (IMPROVEMENTS item 50).
#
#   docker build -t vault .
#   docker run -d --name vault -p 4000:4000 \
#     -v /path/to/media:/media -v vault-data:/app/server/data vault
#
# ffmpeg is installed in the image so transcoding, thumbnails, trickplay and
# HLS work out of the box (the host sandbox may not have it, containers do).
FROM node:22-bookworm-slim AS deps

WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund || npm install --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim

# ffmpeg + ffprobe power transcoding, thumbnails, trickplay and HLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    VAULT_PORT=4000 \
    VAULT_HOST=0.0.0.0

WORKDIR /app

COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY docs ./docs
COPY scripts ./scripts

# Runtime data (config.json, library.json, trash, backups, cache) lives in a
# volume so upgrades never lose it. /media is where hosts mount their library.
RUN mkdir -p /app/server/data /app/server/cache /app/server/logs \
      /media/movies /media/tv /media/music /media/videos /media/audiobooks /media/comics /media/podcasts \
  && chown -R node:node /app/server /media

USER node
WORKDIR /app/server
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VAULT_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
