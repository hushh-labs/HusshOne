FROM node:20-bookworm

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV LINKEDIN_PROFILE_SCRAPER_HEADLESS=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev

COPY server.mjs ./server.mjs
COPY inputs ./inputs
COPY README.md ./README.md

RUN mkdir -p secrets outputs/linkedin-profile-scraper logs

CMD ["npm", "start"]
