/**
 * insider-holdings-api — Section 16 insiders near a location, ranked by the position
 * value they disclosed themselves.
 *
 * Node standard library only, no runtime dependencies, matching the rest of this fleet.
 *
 * Routes
 *   GET /health                 open   uptime + index freshness
 *   GET /v1/stats               open   counters, no per-identity usage
 *   GET /v1/insiders            keyed  location search, streamed
 *   GET /v1/insiders/{cik}      keyed  one filer's disclosed positions
 *   GET /v1/issuers/{cik}       keyed  one company, never a person name
 */

import http from "node:http";
import path from "node:path";

import { config } from "./scripts/lib/config.mjs";
import { ATTRIBUTION, stripOwnerAddress } from "./scripts/lib/disclosure.mjs";
import { QueryError, parseQuery } from "./scripts/lib/query.mjs";
import { RateLimiter, clientIp } from "./scripts/lib/rate-limit.mjs";
import { getIssuer, getPerson, indexMeta, searchNearby } from "./scripts/lib/index-store.mjs";

const SERVICE = "insider-holdings-api";
const DATA_DIR = path.resolve(config.dataDir);
const limiter = new RateLimiter(config.rateLimit);

const counters = { requests: 0, searches: 0, profiles: 0, rateLimited: 0, unauthorized: 0 };

function sendJson(response, status, body) {
  const payload = JSON.stringify(stripOwnerAddress(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

const server = http.createServer(async (request, response) => {
  const started = Date.now();
  counters.requests += 1;

  try {
    const url = new URL(request.url || "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      const meta = indexMeta(DATA_DIR);
      const stale = meta.ageDays != null && meta.ageDays > config.staleAfterDays;
      return sendJson(response, 200, {
        ok: true,
        service: SERVICE,
        timestamp: new Date().toISOString(),
        index: {
          ...meta,
          stale,
          staleAfterDays: config.staleAfterDays,
          note: meta.built
            ? "Index loaded. The SEC publishes these datasets quarterly, so an age in the tens of days is normal."
            : "No index built yet. Run scripts/fetch-centroids.mjs then scripts/build-index.mjs.",
        },
        sources: {
          secDatasets: config.sec.datasetBase,
          edgarSubmissions: config.sec.submissionsBase,
          note: "Every upstream is free and public. No paid data vendor is used.",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/stats") {
      return sendJson(response, 200, {
        ok: true,
        service: SERVICE,
        uptimeSec: Math.round(process.uptime()),
        counters: { ...counters },
        index: indexMeta(DATA_DIR),
        rateLimit: {
          perMinute: config.rateLimit.perMinute,
          burst: config.rateLimit.burst,
          trackedClients: limiter.trackedClients,
        },
        disclosurePolicy: {
          indexed: "Officers, directors and greater-than-10% owners who file Forms 3, 4 and 5 under Section 16.",
          neverIndexed:
            "Anyone who does not personally file a Section 16 report. No inferred wealth, no property records, no donations, no spouses.",
          addressPolicy:
            "Locations are issuer business addresses from EDGAR. A filer's own address is never read or returned.",
        },
      });
    }

    // Everything below names a person or reads the index. Gate it.
    if (config.apiKey && url.pathname.startsWith("/v1/")) {
      if (String(request.headers.authorization || "") !== `Bearer ${config.apiKey}`) {
        counters.unauthorized += 1;
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
    }

    if (url.pathname.startsWith("/v1/")) {
      const allowed = limiter.take(clientIp(request, config.rateLimit.trustedProxyCount));
      if (!allowed.ok) {
        counters.rateLimited += 1;
        response.setHeader("retry-after", String(allowed.retryAfterSec));
        return sendJson(response, 429, {
          ok: false,
          error: "Rate limit exceeded",
          retryAfterSec: allowed.retryAfterSec,
        });
      }
    }

    const personRoute = url.pathname.match(/^\/v1\/insiders\/(\d+)$/);
    if (request.method === "GET" && personRoute) {
      counters.profiles += 1;
      const person = getPerson(personRoute[1], DATA_DIR);
      if (!person) return sendJson(response, 404, { ok: false, error: "No Section 16 filer with that CIK in the current index." });
      return sendJson(response, 200, { ok: true, insider: person, attribution: ATTRIBUTION });
    }

    const issuerRoute = url.pathname.match(/^\/v1\/issuers\/(\d+)$/);
    if (request.method === "GET" && issuerRoute) {
      const issuer = getIssuer(issuerRoute[1], DATA_DIR);
      if (!issuer) return sendJson(response, 404, { ok: false, error: "No issuer with that CIK in the current index." });
      return sendJson(response, 200, {
        ok: true,
        issuer,
        disclosure: "Firm-level record only. This route never returns the names of a company's insiders.",
        attribution: ATTRIBUTION,
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/insiders") {
      return handleSearch(request, response, url, started);
    }

    return sendJson(response, 404, { ok: false, error: "Not found", service: SERVICE });
  } catch (error) {
    const status = error instanceof QueryError ? 400 : 500;
    if (response.headersSent) {
      try {
        response.write(`${JSON.stringify({ type: "error", error: error.message })}\n`);
      } catch { /* the socket is already gone */ }
      return response.end();
    }
    return sendJson(response, status, {
      ok: false,
      error: error.message,
      type: error.name || "Error",
      field: error.field,
    });
  }
});

function handleSearch(request, response, url, started) {
  counters.searches += 1;
  const query = parseQuery(url.searchParams, DATA_DIR);
  const result = searchNearby(query, DATA_DIR);

  const meta = {
    type: "meta",
    service: SERVICE,
    resolved: { lat: query.lat, lng: query.lng },
    resolvedFrom: query.resolvedFrom,
    radiusMi: query.radiusMi,
    minValue: query.minValue,
    total: result.total,
    returned: Math.min(query.limit, Math.max(0, result.total - query.offset)),
    offset: query.offset,
    hasMore: query.offset + query.limit < result.total,
    issuersInRange: result.issuersInRange,
    index: indexMeta(DATA_DIR),
    attribution: ATTRIBUTION,
  };

  if (query.stream === "json") {
    return sendJson(response, 200, { ok: true, ...meta, insiders: result.rows });
  }

  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  response.write(`${JSON.stringify(stripOwnerAddress(meta))}\n`);
  for (const [rank, row] of result.rows.entries()) {
    response.write(`${JSON.stringify(stripOwnerAddress({ type: "insider", rank: query.offset + rank + 1, insider: row }))}\n`);
  }
  response.write(`${JSON.stringify({ type: "done", ms: Date.now() - started, returned: result.rows.length })}\n`);
  return response.end();
}

if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, () => {
    console.log(`[${SERVICE}] listening on :${config.port} (data: ${DATA_DIR})`);
  });
}

export { server, handleSearch };
