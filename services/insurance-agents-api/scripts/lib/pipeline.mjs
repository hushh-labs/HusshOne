// The search pipeline: a location query in, distance-ranked agencies out.
//
// The upstream returns a wide, already-distance-sorted set (704 for one Kirkland ZIP) with a
// per-result `milesToQueryLocation`, and full agency data inline — so, like the BrokerCheck
// build, there is no distance to synthesize and no per-record detail fetch. The work here is
// paging up to the ceiling (SEQUENTIALLY + paced, because Akamai punishes bursts), mapping,
// de-duping, optional radius filtering, ranking, and caching.

import { config } from "./config.mjs";
import { searchPage } from "./nationwide.mjs";
import { mapAgency } from "./agent.mjs";
import { queryCache, SCHEMA_VERSION } from "./cache.mjs";

/** One agency, one row (the API can repeat a location across pages). */
function dedupe(agencies) {
  const seen = new Set();
  return agencies.filter((a) => {
    if (!a?.id || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

/** Page through the locator until the ceiling is reached or the results run out.
 *  SEQUENTIAL on purpose: parallel pages would look like a burst to Akamai. Cheap in
 *  practice — the cache means a given area is paged at most once per day. */
async function fetchCandidates({ q, ceiling }) {
  const first = await searchPage({ q, page: 1 });
  const total = first.total;
  const perPage = first.resultsPerPage || config.nationwide.resultsPerPage;

  // Accumulate with a running de-dupe so we can STOP the moment a page adds nothing new.
  // This makes paging robust to an unconfirmed page param: if `page=N` doesn't actually
  // advance (the API returns page 1 again), the second fetch contributes zero new ids and we
  // stop — instead of hammering Akamai with identical requests. When the correct param is in
  // place, real new records keep it going up to the ceiling.
  const seen = new Set();
  const agencies = [];
  const absorb = (locations) => {
    let added = 0;
    for (const a of locations.map((e) => mapAgency(e)).filter(Boolean)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      agencies.push(a);
      added++;
    }
    return added;
  };
  absorb(first.locations);

  const maxPages = Math.ceil(Math.min(ceiling, total) / perPage);
  let pagesFetched = 1;
  for (let page = 2; page <= maxPages && agencies.length < ceiling; page++) {
    const next = await searchPage({ q, page }).catch(() => null);
    pagesFetched++;
    if (!next || !next.locations.length) break;
    if (absorb(next.locations) === 0) break; // page didn't advance — stop
  }

  return {
    agencies: agencies.slice(0, ceiling),
    total,
    queryLocation: first.queryLocation,
    // Honest about which limit we hit: our ceiling, or the API not paging past what we got.
    truncatedBy: total > agencies.length ? (agencies.length >= ceiling ? "candidateCeiling" : "upstreamPaging") : null,
    pagesFetched,
  };
}

/** Rank by true distance. The API pre-sorts, but a stable id tiebreak keeps ordering
 *  deterministic across cache refreshes so pagination never repeats or skips a row. */
function rank(agencies) {
  return [...agencies].sort((a, b) => {
    if (a.distanceMeters == null) return b.distanceMeters == null ? a.id.localeCompare(b.id) : 1;
    if (b.distanceMeters == null) return -1;
    if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters;
    return a.id.localeCompare(b.id);
  });
}

/** Resolve + rank agencies for a query, read-through cached by the `q` string + ceiling.
 *  `radiusMi` is applied AFTER caching (a client-side filter on the API's own miles), so the
 *  same cached candidate set serves any radius. */
export async function resolveAgencies({ q, radiusMi }) {
  const cacheKey = `v${SCHEMA_VERSION}|${q.toLowerCase()}|${config.search.candidateCeiling}`;

  let base = queryCache.get(cacheKey);
  let cache = "warm";
  if (!base) {
    base = await fetchCandidates({ q, ceiling: config.search.candidateCeiling });
    queryCache.set(cacheKey, base);
    cache = "cold";
  }

  let ranked = rank(base.agencies);
  if (radiusMi != null) ranked = ranked.filter((a) => a.distanceMiles == null || a.distanceMiles <= radiusMi);

  return {
    ranked,
    total: base.total,
    queryLocation: base.queryLocation,
    truncatedBy: base.truncatedBy,
    pagesFetched: base.pagesFetched,
    cache,
  };
}
