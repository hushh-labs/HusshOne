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

# The index is baked into the image so a container serves immediately rather than
# spending forty-five minutes talking to the SEC while requests arrive.
#
# If data/index.json is already in the build context it is reused as-is. That is the
# normal path: build it once with `npm run build-index`, then every container build is
# seconds rather than an hour, and the deployed image is byte-identical to what was
# tested locally. `.gcloudignore` deliberately lets the file through even though git
# ignores it.
#
# Only when no index is present does the image build one, and then SEC_USER_AGENT is
# required — the SEC returns 403 to anonymous clients, so a missing value must fail
# loudly here instead of shipping an image with a silently empty index.
ARG SEC_USER_AGENT
ARG INDEX_QUARTER=2026q2
RUN if [ -s data/index.json ]; then \
      echo "Using the index already in the build context ($(du -h data/index.json | cut -f1))."; \
    elif [ -n "$SEC_USER_AGENT" ]; then \
      SEC_USER_AGENT="$SEC_USER_AGENT" node scripts/build-index.mjs --quarter "$INDEX_QUARTER"; \
    else \
      echo "No data/index.json and no SEC_USER_AGENT build-arg. Supply one or the other:" >&2; \
      echo "  npm run build-index   (then rebuild)   OR   --build-arg SEC_USER_AGENT=..." >&2; \
      exit 1; \
    fi

EXPOSE 8080

# /health is open and needs no index, so it answers even on a cold or unbuilt container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
