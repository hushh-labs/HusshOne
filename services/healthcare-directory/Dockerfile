# US healthcare directory — no browser/login stack (NPPES data is public domain), so
# this image is a plain slim Node runtime. `unzip` is included because the bulk NPPES
# zip is unpacked with the system unzip (Node has no built-in unzip), same as the
# fleet fetches GeoNames.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates unzip \
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
