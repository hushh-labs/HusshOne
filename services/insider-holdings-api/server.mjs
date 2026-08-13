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
import { collapseCoFiled, subjectType, summarise } from "./scripts/lib/orchestrate.mjs";
import { floridaMeta, searchFlorida } from "./scripts/lib/florida-store.mjs";
import { form144Meta, liquidityFor, searchLiquidity } from "./scripts/lib/form144-store.mjs";
import { cmsMeta, searchPhysicians } from "./scripts/lib/cms-store.mjs";
import { advMeta, searchAdvOwners } from "./scripts/lib/adv-store.mjs";

const SERVICE = "insider-holdings-api";
const DATA_DIR = path.resolve(config.dataDir);
const limiter = new RateLimiter(config.rateLimit);

const counters = { requests: 0, searches: 0, profiles: 0, rateLimited: 0, unauthorized: 0 };

if (config.requireApiKey && config.apiKey.length < 32) {
  throw new Error(
    "INSIDER_API_KEY must be at least 32 characters when INSIDER_REQUIRE_API_KEY is enabled",
  );
}

const PROFESSIONAL_RANKING = Object.freeze({
  mode: "professional",
  relationshipScope: "selected_position",
  orderedBy: [
    "officer_director_role_authority",
    "filing_recency",
    "issuer_office_distance",
  ],
  excludes: ["disclosed_value", "market_value"],
  note:
    "Professional ordering never reads position value. Location is the issuer's public office, not the filer's residence or physical presence.",
});

function requestedRanking(url) {
  return (url.searchParams.get("ranking") || "").trim().toLowerCase() === "professional"
    ? "professional"
    : "financial";
}

function summariseProfessional(rows) {
  const issuers = new Set();
  let officers = 0;
  let directors = 0;
  let latestFilingAsOf = null;
  let oldestFilingAsOf = null;

  for (const row of rows) {
    const roles = new Set((row.roles || []).map((role) => String(role).toLowerCase()));
    if (roles.has("officer")) officers += 1;
    if (roles.has("director")) directors += 1;
    if (row.issuer?.cik) issuers.add(String(row.issuer.cik));
    const asOf = row.professional?.filingAsOf || null;
    if (asOf && (latestFilingAsOf == null || asOf > latestFilingAsOf)) latestFilingAsOf = asOf;
    if (asOf && (oldestFilingAsOf == null || asOf < oldestFilingAsOf)) oldestFilingAsOf = asOf;
  }

  return {
    filers: rows.length,
    officers,
    directors,
    issuers: issuers.size,
    latestFilingAsOf,
    oldestFilingAsOf,
    valueUsedForSelectionOrRanking: false,
  };
}

function professionalIndexStatus() {
  const meta = indexMeta(DATA_DIR);
  return {
    ...meta,
    stale: meta.ageDays != null && meta.ageDays > config.staleAfterDays,
    staleAfterDays: config.staleAfterDays,
  };
}

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
        liquidity: form144Meta(DATA_DIR),
        physicianOwnership: cmsMeta(DATA_DIR),
        adviserOwners: advMeta(DATA_DIR),
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
    if (config.requireApiKey && url.pathname.startsWith("/v1/")) {
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
      const ranking = requestedRanking(url);
      const query = { ...parseQuery(url.searchParams, DATA_DIR), ranking };
      const professionalMode = ranking === "professional";

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
      const rankedRows = professionalMode
        ? all.rows.map((row) => ({ ...row, subjectType: subjectType(row.name) }))
        : collapseCoFiled(all.rows);

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
        ? rankedRows.filter((row) => row.subjectType === wanted)
        : rankedRows;

      const page = visible.slice(query.offset, query.offset + query.limit).map((row) => {
        if (professionalMode) return row;
        // Enrich only the returned page: a Form 144 lookup per row across the whole
        // radius would be wasted on rows nobody sees.
        const liquidity = liquidityFor(row.cik, DATA_DIR);
        return liquidity ? { ...row, liquidity } : row;
      });

      return sendJson(response, 200, {
        ok: true,
        resolved: { lat: query.lat, lng: query.lng },
        resolvedFrom: query.resolvedFrom,
        radiusMi: query.radiusMi,
        ...(professionalMode
          ? { ranking: PROFESSIONAL_RANKING, index: professionalIndexStatus() }
          : {}),
        // Describes the whole radius, before any subjectType filter.
        summary: professionalMode ? summariseProfessional(rankedRows) : summarise(rankedRows),
        subjectTypeFilter: ["person", "entity"].includes(wanted) ? wanted : null,
        // `holders`, not `people`: Section 16 names funds and holding companies
        // alongside human beings, and calling the array `people` asserted something
        // untrue of nearly 40% of the value around Kirkland.
        holders: page,
        returned: page.length,
        total: visible.length,
        totalBeforeFilter: rankedRows.length,
        hasMore: query.offset + page.length < visible.length,
        collapsedFrom: all.rows.length,
        duplicatesRemoved: professionalMode ? 0 : all.rows.length - rankedRows.length,
        sources: {
          section16: {
            contributes: professionalMode
              ? "Named Section 16 filers ordered by Officer/Director authority, filing recency, and issuer-office distance; position value is excluded from selection and ranking."
              : "Named officers, directors and 10%+ owners of public companies, ranked by disclosed position value and distance to their employer's office.",
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
     * Investment-adviser owners — SEC Form ADV Schedule A/B.
     *
     * The largest population in this service: ~144,000 named individuals who own or
     * control a registered investment adviser or exempt reporting adviser.
     *
     * Two things make it different from every other source here. `crd` is the SEC's own
     * individual identifier, so these records join directly to IAPD and to this repo's
     * ria-identity-api — no other source supplies a person-level regulator id. And it
     * reports CONTROL separately from size, because a 5% holder can direct a firm while
     * a 30% holder may not.
     *
     * Ownership is a BAND, never a dollar figure, and code F is reported as ambiguous
     * rather than guessed — see lib/adv-owners.mjs. There is no address of any kind in
     * Schedule A/B, so this route carries no geography and takes no lat/lng.
     */
    if (request.method === "GET" && url.pathname === "/v1/adviser-owners") {
      const minOwnershipRaw = url.searchParams.get("minOwnership");
      const result = searchAdvOwners(
        {
          name: url.searchParams.get("name"),
          crd: url.searchParams.get("crd"),
          minOwnership: minOwnershipRaw == null ? null : Number(minOwnershipRaw),
          controlOnly: /^(1|true|yes)$/i.test(url.searchParams.get("controlOnly") || ""),
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
        index: advMeta(DATA_DIR),
        joinKey: "crd is the SEC individual CRD — the same identifier IAPD and ria-identity-api use.",
        ownershipNote:
          "Ownership is a percentage BAND, never a dollar figure. Code F appears on an older form scale the current legend does not define, so rows carrying it are reported as ambiguous and excluded from largestOwnership and from any minOwnership threshold rather than guessed.",
        disclosure:
          "Schedule A/B contains no address of any kind, so these records carry no location and are never distance-ranked.",
        attribution: {
          source: "SEC Form ADV Schedule A and B — direct and indirect owners",
          sourceUrl: "https://adviserinfo.sec.gov",
          coverage: "Bulk archive 2011-11-05 to 2024-12-31. Owner data from 2025 onward exists only on the per-firm ADV Part 1 PDF.",
        },
      });
    }

    /**
     * Physician ownership stakes — CMS Open Payments.
     *
     * The Sunshine Act (42 U.S.C. §1320a-7h) makes drug and device makers report, by
     * name, any ownership interest a physician holds in them — with an EXACT DOLLAR
     * value rather than a band. It is the only source here covering a profession rather
     * than a corporate role, so it reaches people no SEC filing ever will.
     *
     * Physicians only. Roughly 8% of rows are held by an immediate family member, who
     * accepted no disclosure duty, and those are excluded at ingest.
     *
     * City and state only: the source's "primary business address" is a hospital for
     * some and a solo practice — routinely a home — for others, with no flag between
     * them. Free-text terms are scrubbed of anything address-shaped before serving.
     */
    if (request.method === "GET" && url.pathname === "/v1/physician-ownership") {
      const result = searchPhysicians(
        {
          name: url.searchParams.get("name"),
          specialty: url.searchParams.get("specialty"),
          company: url.searchParams.get("company"),
          state: url.searchParams.get("state"),
          minValue: Number(url.searchParams.get("minValue")) || 0,
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
        index: cmsMeta(DATA_DIR),
        disclosure:
          "Ownership and investment interests physicians hold in drug and device manufacturers, reported by those manufacturers under the Physician Payments Sunshine Act. Interests held by an immediate family member are excluded. Location is city and state only.",
        valuationNotice:
          "valueOfInterest is an exact dollar figure for one stake in one company, reported by that company. Stakes in different companies are summed because each is valued once — unlike a Form 144 notice, which may repeat the same shares.",
        attribution: {
          source: "CMS Open Payments — Physician Ownership and Investment Interest",
          sourceUrl: "https://openpaymentsdata.cms.gov",
          licence: "US Government work — https://www.usa.gov/government-works",
        },
      });
    }

    /**
     * Liquidity — SEC Form 144 notices of proposed sale.
     *
     * Everything else here reports what someone HOLDS. This reports what they have
     * signalled they may SELL, in exact dollars they supplied. Shares are not cash, and
     * a large holder who has noticed no sale is in a different position from one who
     * has noticed $50m — which a holdings figure alone cannot express.
     *
     * A notice is an INTENT, not a completed sale, and the same shares can be noticed
     * repeatedly. So this is never summed into a holding and the field names say so.
     */
    if (request.method === "GET" && url.pathname === "/v1/liquidity") {
      const result = searchLiquidity(
        {
          name: url.searchParams.get("name"),
          issuer: url.searchParams.get("issuer"),
          minValue: Number(url.searchParams.get("minValue")) || 0,
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
        index: form144Meta(DATA_DIR),
        valuationNotice:
          "aggregateMarketValue is the value of a PROPOSED sale the filer notified. The sale need not occur, and the same shares may be noticed more than once, so these figures are never summed and never added to a holding. largestProposedSale is the biggest single notice, not a total.",
        attribution: ATTRIBUTION,
      });
    }

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
  const ranking = requestedRanking(url);
  const query = { ...parseQuery(url.searchParams, DATA_DIR), ranking };
  const professionalMode = ranking === "professional";
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
    ...(professionalMode ? { ranking: PROFESSIONAL_RANKING } : {}),
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
