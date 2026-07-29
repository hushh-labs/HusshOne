# US insurance producer directory — no browser/login stack (data comes from open
# per-state datasets over HTTPS), so this image is a plain slim Node runtime.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server.mjs worker.mjs schema.sql ./
COPY scripts ./scripts
COPY inputs ./inputs
COPY README.md ./README.md

RUN mkdir -p secrets outputs logs

# Default entrypoint is the API; the VM runs the worker via its own systemd unit.
CMD ["npm", "start"]
