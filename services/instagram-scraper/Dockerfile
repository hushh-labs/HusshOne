FROM node:20-bookworm

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./server.mjs
COPY scripts ./scripts
COPY inputs ./inputs
COPY README.md ./README.md

RUN mkdir -p secrets outputs/api logs

CMD ["npm", "start"]
