FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./server.mjs
COPY README.md ./README.md

CMD ["npm", "start"]
