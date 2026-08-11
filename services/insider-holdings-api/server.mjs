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
import { formDMeta, searchFormD } from "./scripts/lib/formd-store.mjs";
import { collapseCoFiled, summarise } from "./scripts/lib/orchestrate.mjs";
import { floridaMeta, searchFlorida } from "./scripts/lib/florida-store.mjs";

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
        // Reported so a dataset that failed to reach the image is visible here rather
        // than showing up as an endpoint that quietly returns nothing.
        privateOfferings: formDMeta(DATA_DIR),
        netWorth: floridaMeta(DATA_DIR),
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

    /**
     * ONE CALL, EVERY SOURCE. The endpoint a client should actually use.
     *
     * /v1/insiders is the raw feed and stays as it is. This is the orchestrated view:
     * co-filed positions collapsed, an aggregate of the area, and an explicit statement
     * of what each source did and did not contribute — including that Form D founders
     * are deliberately absent from the ranking rather than missing by accident.
     */
    if (request.method === "GET" && url.pathname === "/v1/around") {
      const query = parseQuery(url.searchParams, DATA_DIR);

      /**
       * Collapse over the WHOLE radius, not over a page.
       *
       * Two reasons it has to be the whole set. Co-filers are not guaranteed to be
       * adjacent in the ranking, so a page-sized window can split one position across
       * two pages and collapse neither. And the summary must describe the area — an
       * earlier revision summarised only the fetched window and reported "39 people,
       * $343bn" for a radius holding 640, which reads as an area total and is not one.
       *
       * The index is in memory and a radius holds hundreds of rows, so this is cheap.
       */
      const all = searchNearby({ ...query, limit: Number.MAX_SAFE_INTEGER, offset: 0 }, DATA_DIR);
      const collapsed = collapseCoFiled(all.rows);

      /**
       * `?subjectType=person` drops corporate filers.
       *
       * Section 16 names funds and holding companies alongside human beings, and around
       * Kirkland the corporations hold 39% of the top-100 value. A caller asking "who
       * near me holds a lot" usually means people, and until now had no way to say so.
       *
       * The summary is computed BEFORE this filter so it always describes the whole
       * area, and reports the person/entity split either way.
       */
      const wanted = (url.searchParams.get("subjectType") || "").trim().toLowerCase();
      const visible = ["person", "entity"].includes(wanted)
        ? collapsed.filter((row) => row.subjectType === wanted)
        : collapsed;

      const page = visible.slice(query.offset, query.offset + query.limit);

      return sendJson(response, 200, {
        ok: true,
        resolved: { lat: query.lat, lng: query.lng },
        resolvedFrom: query.resolvedFrom,
        radiusMi: query.radiusMi,
        // Describes the whole radius, before any subjectType filter.
        summary: summarise(collapsed),
        subjectTypeFilter: ["person", "entity"].includes(wanted) ? wanted : null,
        // `holders`, not `people`: Section 16 names funds and holding companies
        // alongside human beings, and calling the array `people` asserted something
        // untrue of nearly 40% of the value around Kirkland.
        holders: page,
        returned: page.length,
        total: visible.length,
        totalBeforeFilter: collapsed.length,
        hasMore: query.offset + page.length < visible.length,
        collapsedFrom: all.rows.length,
        duplicatesRemoved: all.rows.length - collapsed.length,
        sources: {
          section16: {
            contributes: "Named officers, directors and 10%+ owners of public companies, ranked by disclosed position value and distance to their employer's office.",
            people: indexMeta(DATA_DIR).people,
          },
          formD: {
            contributes: "Officers and directors of private companies that raised under Regulation D.",
            people: formDMeta(DATA_DIR).people,
            excludedFromRanking:
              "Not distance-ranked, by design. A small private issuer's filed address is frequently the founder's home, so these are searchable by name and company at /v1/private-offerings and reported by city only.",
          },
        },
        attribution: ATTRIBUTION,
      });
    }

    /**
     * Private-company officers and directors, from Form D.
     *
     * Name/company lookup only — no lat, lng or radius, and none will be added. Form D
     * issuer addresses are routinely the founder's home, so distance-ranking these
     * would place residences on the map. City and state are the finest granularity
     * this route will ever return.
     */
    /**
     * Sworn net worth — Florida Form 6.
     *
     * The only source in the country publishing an exact, sworn net-worth figure for a
     * named individual, mandated by Article II §8(j)(1) of the Florida Constitution.
     * Everywhere else in this service the number is one holding in one company; here it
     * is the person's whole declared position, as they swore to it.
     *
     * Ranked by net worth, searchable by name, county and office. No coordinates: the
     * underlying PDFs print real property by street address, so only the figure is read.
     */
    if (request.method === "GET" && url.pathname === "/v1/net-worth") {
      const result = searchFlorida(
        {
          name: url.searchParams.get("name"),
          county: url.searchParams.get("county"),
          office: url.searchParams.get("office"),
          minNetWorth: Number(url.searchParams.get("minNetWorth")) || 0,
          limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25)),
          offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
        },
        DATA_DIR,
      );

      return sendJson(response, 200, {
        ok: true,
        total: result.total,
        returned: result.rows.length,
        people: result.rows,
        index: floridaMeta(DATA_DIR),
        coverage:
          "Florida officials required to file Form 6. This is the only US regime publishing an exact sworn net worth; every other source here reports a single holding in a single company.",
        disclosure:
          "Only the sworn net-worth figure is extracted from each filing. The asset, liability and income schedules are never read or stored, because Form 6 identifies real property by street address. Location is the county and office the person is elected to serve — there are no coordinates.",
        attribution: {
          source: "Florida Commission on Ethics — Form 6, Art. II §8(j)(1), Fla. Const.",
          sourceUrl: "https://disclosure.floridaethics.gov/PublicSearch/Filings",
          notice: "Filers swear to these figures. The Commission's own record is authoritative.",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/private-offerings") {
      const result = searchFormD(
        {
          name: url.searchParams.get("name"),
          company: url.searchParams.get("company"),
          state: url.searchParams.get("state"),
          limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25)),
          offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
        },
        DATA_DIR,
      );

      if (result.error) return sendJson(response, 400, { ok: false, error: result.error, field: "name" });

      return sendJson(response, 200, {
        ok: true,
        total: result.total,
        returned: result.rows.length,
        people: result.rows,
        index: formDMeta(DATA_DIR),
        disclosure:
          "Officers, directors and promoters named on a company's Form D. Location is city and state only: a small private issuer's filed address is frequently a residence, so these records are never geocoded or ranked by distance.",
        valuationNotice:
          "Offering amounts are money the COMPANY raised. Form D does not state what share of the company any named person holds, so no personal wealth figure can be derived from it.",
        attribution: ATTRIBUTION,
      });
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
