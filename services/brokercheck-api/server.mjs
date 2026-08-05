// BrokerCheck Advisor API — a standalone, public, read-only HTTP endpoint.
//
// Send coordinates, get distance-ranked financial advisers with full profiles, streamed.
// One bearer key gates /v1/*; /health stays open for uptime probes. The service holds no
// credentials of its own — FINRA needs none and there is no database — so that key exists
// solely to decide who may call us. A per-IP token bucket bounds abuse on top.
//
// Streaming is two-tier, because position and depth resolve at very different speeds:
//   batch  frames carry stubs (name, firm, distance) and land in ~1-2s — enough to render
//   detail frames carry full profiles and fill in behind, keyed by CRD
// The ordering is FROZEN before any batch is emitted (see ranking_final), so a card never
// moves under the user's cursor.

import http from "node:http";
import { config, ATTRIBUTION } from "./scripts/lib/config.mjs";
import { resolveWithAutoTighten, groupByBranch, hydrate, hydrateFirm, attachFirmContact } from "./scripts/lib/pipeline.mjs";
import { resolveLocation } from "./scripts/lib/finra.mjs";
import { allCacheStats, loadSnapshot, saveSnapshot, startSnapshotTimer, persistenceStatus } from "./scripts/lib/cache.mjs";
import { parseQuery, QueryError } from "./scripts/lib/query.mjs";
import { RateLimiter } from "./scripts/lib/rate-limit.mjs";

const SERVICE = "brokercheck-api";
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

    // Optional bearer gate. Empty key (the default) means open — but unlike the rest of
    // the fleet we fail CLOSED when a key IS configured, so setting one actually protects.
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

    const single = url.pathname.match(/^\/v1\/advisors\/(\d+)$/);
    if (request.method === "GET" && single) {
      const profile = await hydrate(single[1]);
      // Join the employer in so one call answers "who are they AND how do I reach them".
      const firmId = profile.firmHistory.find((f) => f.current)?.firmId;
      const firm = firmId ? await hydrateFirm(firmId).catch(() => null) : null;
      return sendJson(response, 200, { ok: true, profile, firm, attribution: ATTRIBUTION });
    }

    const firmRoute = url.pathname.match(/^\/v1\/firms\/(\d+)$/);
    if (request.method === "GET" && firmRoute) {
      return sendJson(response, 200, { ok: true, firm: await hydrateFirm(firmRoute[1]), attribution: ATTRIBUTION });
    }

    if (request.method === "GET" && url.pathname === "/v1/advisors") {
      return await handleSearch(request, response, url, started);
    }

    return sendJson(response, 404, { ok: false, error: "Not found", service: SERVICE });
  } catch (error) {
    const status = error instanceof QueryError ? 400 : 502;
    if (response.headersSent) {
      // Mid-stream: emit a terminal error frame rather than truncating silently.
      try {
        response.write(`${JSON.stringify({ type: "error", error: message(error) })}\n`);
      } catch {}
      return response.end();
    }
    return sendJson(response, status, { ok: false, error: message(error), type: error?.name || "Error" });
  }
});

async function handleSearch(request, response, url, started) {
  const query = await parseQuery(url.searchParams, { resolveLocation });
  const emit = makeEmitter(response, query.stream);

  const resolved = await resolveWithAutoTighten(query);
  const grouped = query.groupBy === "branch" || (query.groupBy === "auto" && shouldGroup(resolved));
  // Page out of the FROZEN ranking. Because that ordering is cached, "show 10 more" is a
  // slice of the same list page 1 came from — it costs no upstream calls and can never
  // re-order what the caller is already displaying.
  const allRows = grouped ? groupByBranch(resolved.ranked) : resolved.ranked;
  const page = allRows.slice(query.offset, query.offset + query.limit);
  if (query.withFirmContact) await attachFirmContact(page);
  const hasMore = query.offset + page.length < allRows.length;

  emit({
    type: "meta",
    service: SERVICE,
    resolved: { lat: query.lat, lng: query.lng },
    resolvedFrom: query.resolvedFrom,
    radiusMi: resolved.radiusMi,
    radiusRequested: resolved.radiusRequested,
    radiusAdjusted: resolved.radiusAdjusted,
    // The honest count of everyone FINRA reports in the radius, which may exceed what we
    // ranked. `truncatedBy` says why, so a partial answer never reads as a complete one.
    estimatedTotal: resolved.total,
    ranked: resolved.ranked.length,
    // Paging state, so a caller knows whether a "show 10 more" control should exist and
    // exactly what to send for it.
    offset: query.offset,
    limit: query.limit,
    returned: page.length,
    available: allRows.length,
    hasMore,
    nextOffset: hasMore ? query.offset + page.length : null,
    uniqueLocations: resolved.uniqueLocations,
    pagesFetched: resolved.pagesFetched ?? null,
    truncatedBy: resolved.truncatedBy,
    grouped,
    filter: resolved.filter,
    cache: resolved.cache,
    geoPrecisionNote:
      "Distances are computed from ZIP-centroid coordinates published by FINRA and are approximate; they are not rooftop-accurate.",
    attribution: ATTRIBUTION,
  });

  const frameType = grouped ? "branches" : "batch";
  for (let i = 0; i < page.length; i += query.batchSize) {
    emit({ type: frameType, seq: Math.floor(i / query.batchSize) + 1, items: page.slice(i, i + query.batchSize) });
  }
  emit({ type: "ranking_final", total: page.length, mode: grouped ? "branch" : "person", hasMore, nextOffset: hasMore ? query.offset + page.length : null });

  if (grouped) {
    emit({ type: "done", ms: Date.now() - started, mode: "branch", returned: page.length, hasMore });
    return end(response, query.stream);
  }
  const ranked = page;

  if (query.detail) {
    let hydrated = 0;
    let failed = 0;
    // Rank order, bounded concurrency. Emitted as each completes so the caller fills in
    // cards progressively rather than waiting for the slowest fetch.
    await forEachLimited(ranked, config.finra.concurrency, async (person) => {
      try {
        const profile = await hydrate(person.crd);
        hydrated++;
        emit({ type: "detail", crd: person.crd, profile });
      } catch (error) {
        failed++;
        emit({ type: "detail_error", crd: person.crd, error: message(error) });
      }
    });
    emit({ type: "done", ms: Date.now() - started, mode: "person", returned: ranked.length, hydrated, failed });
  } else {
    emit({ type: "done", ms: Date.now() - started, mode: "person", returned: ranked.length, hydrated: 0, failed: 0 });
  }
  return end(response, query.stream);
}

/** Decide person-mode vs branch-mode for `groupBy=auto`.
 *
 *  This keys off `estimatedTotal` — FINRA's own count for the query — because that is
 *  DETERMINISTIC for a given lat/lng/radius/filter. An earlier version measured
 *  advisors-per-branch across the sampled candidates, but FINRA's relevance ordering
 *  varies between identical calls, so the sample composition (and therefore the ratio)
 *  drifted across the threshold: the same request would return people one moment and
 *  branches the next. For an API another project builds against, a stable answer matters
 *  more than a marginally smarter one.
 *
 *  The sample-based ratio is kept only as a secondary trigger for the case a raw count
 *  cannot see: a modest total that is nonetheless concentrated in a single building. */
function shouldGroup(resolved) {
  if (!resolved.ranked.length) return false;
  if (resolved.total >= config.search.groupThreshold) return true;

  const branches = new Set(resolved.ranked.map((p) => `${p.firm?.firmId}|${p.firm?.branchZip}`)).size;
  return resolved.ranked.length / Math.max(1, branches) >= 20;
}

/** Run `worker` over items with bounded concurrency, in order. */
async function forEachLimited(items, limit, worker) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await worker(items[cursor++]);
    }),
  );
}

/** One emitter, three wire formats. `off` buffers and sends a single JSON document. */
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
      "x-accel-buffering": "no", // defeat proxy buffering, which would defeat streaming
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
    const items = frames.filter((f) => f.type === "batch").flatMap((f) => f.items);
    const branches = frames.filter((f) => f.type === "branches").flatMap((f) => f.items);
    const details = frames.filter((f) => f.type === "detail");
    const profiles = new Map(details.map((f) => [f.crd, f.profile]));
    return sendJson(response, 200, {
      ok: true,
      meta,
      // Fold the streamed details back into their stubs so the buffered shape is what a
      // non-streaming consumer actually wants: one complete list.
      advisors: items.map((item) => (profiles.has(item.crd) ? { ...item, profile: profiles.get(item.crd) } : item)),
      branches,
    });
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

// Warm from the last snapshot BEFORE accepting traffic, so a restart does not dump every
// in-flight user onto the cold path at once.
const warm = await loadSnapshot();
console.log(JSON.stringify({ event: "cache.restored", service: SERVICE, ...warm }));
startSnapshotTimer();

server.listen(config.port, () => {
  console.log(JSON.stringify({ event: "server.started", service: SERVICE, port: config.port }));
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (shuttingDown) return; // a second Ctrl-C must not race the snapshot write
    shuttingDown = true;
    console.log(JSON.stringify({ event: "server.stopping", service: SERVICE, signal }));
    // Hard deadline first: systemd gives us TimeoutStopSec=30, and a hung save must never
    // turn a restart into a kill -9.
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
