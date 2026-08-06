# syntax=docker/dockerfile:1
# RIA Identity API — Cloud Run image.
#
# WHY THIS EXISTS ALONGSIDE scripts/gcp-vm/. That deploy runs an always-on e2-medium, which
# bills 24/7 whether or not a single adviser types a phone number into an onboarding form.
# This image is the SCALE-TO-ZERO alternative: same code, same env contract, no idle bill.
# Both paths stay supported — nothing here changes, replaces or removes the VM deploy.
#
# Base is node:20-slim, matching the repo root Dockerfile (Debian slim, not alpine). This
# service is plain ESM with exactly one runtime dependency (`pg`) and no build step, so the
# image is the base plus node_modules plus ~200KB of .mjs.
#
# THREE THINGS THIS IMAGE MUST NOT DO, all load-bearing:
#
#   1. BAKE A SECRET. Every credential arrives at runtime (Cloud Run --set-secrets, see
#      scripts/cloudrun/deploy-cloudrun.sh). There is no ARG or ENV here that holds one, and
#      none should be added — this repo is public and image layers are readable by anyone who
#      can pull.
#   2. REFUSE TO START WITHOUT A DATABASE. config.mjs is explicit that an unreachable Cloud SQL
#      is not fatal: createStore() opens no socket at import, the live Google Places -> IAPD
#      path still resolves a phone on its own, and /health reports the reachability honestly.
#      Do NOT add a wait-for-postgres entrypoint — it would turn a Cloud SQL blip into a
#      container that never becomes ready, which is strictly worse than degrading.
#   3. RUN AS ROOT.
#
# Node 20 is deliberate and checked: the service uses top-level await and node:test, both
# stable in 20, and nothing newer (no Promise.withResolvers, Object.groupBy, Array.fromAsync
# or import.meta.dirname anywhere in server.mjs or scripts/lib). The VM deploy installs Node 22
# only because Debian 12 ships 18; it is not a floor this code actually needs.

# --- deps: resolve node_modules in a throwaway stage so npm's cache never reaches the image ---
FROM node:20-slim AS deps
WORKDIR /app
# package.json ONLY. This service commits no lockfile (scripts/gcp-vm/deploy-gcp-vm.sh falls
# back the same way), so `npm ci` is not available here — copying a non-existent
# package-lock.json would fail the build outright.
COPY package.json ./
# --omit=dev drops nothing today (`pg` is the sole dependency, there are no devDependencies)
# and keeps that true if one is ever added. --ignore-scripts: nothing in this tree has a
# postinstall, and a dependency that grew one should not get to run during our build.
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts \
 && npm cache clean --force

# --- runner: the shipped image ---------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# Cloud Run injects PORT and config.mjs reads it; 8080 is the default on both sides.
ENV PORT=8080
# The cache snapshot is a LATENCY convenience (cache.mjs treats a missing file as "start
# cold"), and on Cloud Run the filesystem is per-instance and in-memory, so it cannot survive
# a scale-to-zero anyway. Point it at /tmp: the config default /var/lib/ria-identity is not
# writable by a non-root user, which would make every periodic save log a failure for nothing.
ENV CACHE_SNAPSHOT_PATH=/tmp/ria-identity-cache-snapshot.json

# Non-root, same uid/gid convention as the repo root Dockerfile.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs ria

COPY --from=deps --chown=ria:nodejs /app/node_modules ./node_modules
# Only what the server actually imports. scripts/gcp-vm/ (shell), scripts/cloudrun/ (shell),
# the 40KB README and the *.test.mjs files are excluded via .dockerignore.
COPY --chown=ria:nodejs package.json server.mjs ./
COPY --chown=ria:nodejs scripts/lib ./scripts/lib

USER ria
EXPOSE 8080

# Exec form, so node is PID 1 and receives Cloud Run's SIGTERM directly. server.mjs handles it:
# it saves the cache snapshot behind a 10s hard deadline and closes the pg pool. A shell
# wrapper here would swallow the signal and turn every scale-down into a SIGKILL.
CMD ["node", "server.mjs"]
