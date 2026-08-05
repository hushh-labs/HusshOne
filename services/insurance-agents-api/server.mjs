// Insurance Agents API — a standalone, public, read-only HTTP endpoint.
//
// Send coordinates, get distance-ranked insurance agencies (Nationwide locator, via Yext),
// streamed. One bearer key gates /v1/*; /health is open. No domain allow-list — any Hushh
// project calls it with the key. Same edge-case handling as the BrokerCheck service:
// streaming (NDJSON / SSE / buffered), offset pagination over a frozen cached ranking,
// per-IP rate limiting, cache with disk snapshot + schema version, and errors that can
// arrive mid-stream as a terminal frame.

import http from "node:http";
import { config, ATTRIBUTION } from "./scripts/lib/config.mjs";
import { resolveAgencies } from "./scripts/lib/pipeline.mjs";
import { allCacheStats, loadSnapshot, saveSnapshot, startSnapshotTimer, persistenceStatus } from "./scripts/lib/cache.mjs";
import { parseQuery, QueryError } from "./scripts/lib/query.mjs";
import { RateLimiter } from "./scripts/lib/rate-limit.mjs";

const SERVICE = "insurance-agents-api";
const limiter = new RateLimiter(config.rateLimit);

const server = http.createServer(async (request, response) => {
  const started = Date.now();
  try {
    const url = new URL(request.url || "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { ok: true, service: SERVICE, timestamp: new Date().toISOString() });
    }

    if (request.method === "GET" && url.pathname === "/v1/stats") {
      return sendJson(response, 200, {
        ok: true,
        service: SERVICE,
        caches: allCacheStats(),
        persistence: persistenceStatus(),
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (config.apiKey && url.pathname.startsWith("/v1/")) {
      if (String(request.headers.authorization || "") !== `Bearer ${config.apiKey}`) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
    }

    if (url.pathname.startsWith("/v1/")) {
      const allowed = limiter.take(clientIp(request));
      if (!allowed.ok) {
        response.setHeader("retry-after", String(allowed.retryAfterSec));
        return sendJson(response, 429, { ok: false, error: "Rate limit exceeded", retryAfterSec: allowed.retryAfterSec });
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/agents") {
      return await handleSearch(request, response, url, started);
    }

    return sendJson(response, 404, { ok: false, error: "Not found", service: SERVICE });
  } catch (error) {
    const status = error instanceof QueryError ? 400 : 502;
    if (response.headersSent) {
      try {
        response.write(`${JSON.stringify({ type: "error", error: message(error) })}\n`);
      } catch {}
      return response.end();
    }
    return sendJson(response, status, { ok: false, error: message(error), type: error?.name || "Error" });
  }
});

async function handleSearch(request, response, url, started) {
  const query = parseQuery(url.searchParams);
  const emit = makeEmitter(response, query.stream);

  const resolved = await resolveAgencies(query);
  const page = resolved.ranked.slice(query.offset, query.offset + query.limit);
  const hasMore = query.offset + page.length < resolved.ranked.length;

  // The geocoded origin, same key/shape as the BrokerCheck service's meta.resolved, so a
  // consumer's frame handling is identical across both services.
  const resolvedPoint =
    resolved.queryLocation && resolved.queryLocation.latitude != null
      ? { lat: Number(resolved.queryLocation.latitude), lng: Number(resolved.queryLocation.longitude) }
      : query.lat != null && query.lng != null
        ? { lat: query.lat, lng: query.lng }
        : null;

  emit({
    type: "meta",
    service: SERVICE,
    query: query.q,
    resolved: resolvedPoint,
    resolvedFrom: query.resolvedFrom,
    // Extra: the full geocoded location (city/state/zip) so a lat/lng input can be confirmed.
    resolvedLocation: resolved.queryLocation
      ? {
          city: resolved.queryLocation.city,
          state: resolved.queryLocation.state,
          zip: resolved.queryLocation.zip,
          lat: resolved.queryLocation.latitude,
          lng: resolved.queryLocation.longitude,
        }
      : null,
    radiusMi: query.radiusMi ?? null,
    // estimatedTotal = the locator's count for the query; available = what we ranked (after
    // any radius filter) and can page. Render `available` as "N found".
    estimatedTotal: resolved.total,
    available: resolved.ranked.length,
    offset: query.offset,
    limit: query.limit,
    returned: page.length,
    hasMore,
    nextOffset: hasMore ? query.offset + page.length : null,
    pagesFetched: resolved.pagesFetched ?? null,
    truncatedBy: resolved.truncatedBy,
    cache: resolved.cache,
    geoPrecisionNote: "Distances are the locator's own per-result miles from geocoded coordinates; approximate, not rooftop-surveyed.",
    attribution: ATTRIBUTION,
  });

  // Same frame sequence as BrokerCheck: batch(es) → ranking_final → done. One tier only —
  // the locator returns full agency records inline, so there is no separate `detail` phase
  // (BrokerCheck's batch items are stubs its detail frames fill in; ours are already complete).
  for (let i = 0; i < page.length; i += query.batchSize) {
    emit({ type: "batch", seq: Math.floor(i / query.batchSize) + 1, items: page.slice(i, i + query.batchSize) });
  }
  const nextOffset = hasMore ? query.offset + page.length : null;
  emit({ type: "ranking_final", total: page.length, mode: "agency", hasMore, nextOffset });
  emit({ type: "done", ms: Date.now() - started, mode: "agency", returned: page.length, hasMore, nextOffset });
  return end(response, query.stream);
}

function makeEmitter(response, mode) {
  if (mode === "off") {
    const frames = [];
    response.__buffer = frames;
    return (frame) => frames.push(frame);
  }
  if (mode === "sse") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });
    return (frame) => response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  }
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  return (frame) => response.write(`${JSON.stringify(frame)}\n`);
}

function end(response, mode) {
  if (mode === "off") {
    const frames = response.__buffer || [];
    const meta = frames.find((f) => f.type === "meta") || {};
    const agents = frames.filter((f) => f.type === "batch").flatMap((f) => f.items);
    return sendJson(response, 200, { ok: true, meta, agents });
  }
  return response.end();
}

function clientIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket.remoteAddress || "unknown";
}

const message = (error) => (error instanceof Error ? error.message : String(error));

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

const warm = await loadSnapshot();
console.log(JSON.stringify({ event: "cache.restored", service: SERVICE, ...warm }));
startSnapshotTimer();

server.listen(config.port, () => {
  console.log(JSON.stringify({ event: "server.started", service: SERVICE, port: config.port }));
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(0), 10_000);
    deadline.unref();
    try {
      const saved = await saveSnapshot();
      console.log(JSON.stringify({ event: "cache.snapshot_saved", ...saved }));
    } catch (error) {
      console.warn(JSON.stringify({ event: "cache.snapshot_failed", error: error.message }));
    }
    server.close(() => process.exit(0));
  });
}
