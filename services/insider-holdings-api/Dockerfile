# Node standard library only — there is nothing to npm install, so there is no
# dependency layer and no lockfile to drift.
FROM node:20-slim

WORKDIR /app

# unzip is used by the index builder to unpack the SEC's quarterly archives.
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server.mjs ./
COPY scripts ./scripts
# Carries the committed ZIP centroid table. index.json is gitignored and built below.
COPY data ./data

ENV NODE_ENV=production \
    PORT=8080 \
    INSIDER_DATA_DIR=/app/data

# Build the index into the image so a container starts serving immediately instead of
# spending twenty minutes talking to the SEC while requests arrive.
#
# SEC_USER_AGENT must be supplied at build time — the SEC returns 403 without a
# descriptive agent carrying a contact address, so a build with no value fails loudly
# here rather than shipping an image with a silently empty index.
ARG SEC_USER_AGENT
ARG INDEX_QUARTER=2026q2
RUN test -n "$SEC_USER_AGENT" \
      || (echo "SEC_USER_AGENT build-arg is required; the SEC rejects anonymous clients" && exit 1) \
  && SEC_USER_AGENT="$SEC_USER_AGENT" node scripts/build-index.mjs --quarter "$INDEX_QUARTER"

EXPOSE 8080

# /health is open and needs no index, so it answers even on a cold or unbuilt container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
