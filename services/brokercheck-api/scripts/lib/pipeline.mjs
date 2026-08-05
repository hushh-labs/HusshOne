// The search pipeline: coordinates in, distance-ranked advisers out.
//
//   ① candidates   FINRA lat/lon/r search, ALL pages in parallel   ~20 upstream calls
//   ② collapse     group by branch ZIP                             0 calls
//   ③ locate       resolve each unique ZIP to a coordinate         ~1 per unique ZIP, cached forever
//   ④ rank         haversine + sort                                0 calls, and the ONLY true ordering
//   ⑤ hydrate      per-CRD detail, in rank order                   1 per profile, cached 7d
//
// ② is what makes this affordable. Thousands of reps share one office, so a ~1,600-person
// result set collapses to 8-20 unique locations. We resolve coordinates once per location,
// not once per person.
//
// ① fetches the WHOLE radius on purpose. FINRA groups geo results by nearest-ZIP cohort
// rather than interleaving by distance, so a partial fetch returns only the nearest ZIPs and
// makes suburbs inside the radius unreachable. Parallel pages keep that at ~2-3s.

import { config } from "./config.mjs";
import { searchIndividuals, fetchIndividualDetail, fetchIndividualDetailIAPD, fetchFirmDetail, resolveLocation, buildFilter, pooled } from "./finra.mjs";
import { buildProfile, mergeIapdProfile } from "./profile.mjs";
import { buildFirmProfile } from "./firm.mjs";
import { haversineMeters, milesToMeters, geohash, presentDistance, GEO_PRECISION } from "./geo.mjs";
import { branchGeoCache, profileCache, firmCache, queryCache, SCHEMA_VERSION } from "./cache.mjs";

/** ① Page through FINRA until we have the whole radius or hit the ceiling.
 *
 *  Two hard stops: FINRA's own deep-paging window (~8,600 records) and our candidate
 *  ceiling. Whichever we hit is reported, never silently applied — a truncated result
 *  that looks complete is worse than a smaller one that says so. */
async function fetchCandidates({ lat, lng, radiusMi, filter, ceiling }) {
  const rows = config.finra.maxRows;

  // First page tells us the true total, which is what sizes the rest of the work.
  const first = await searchIndividuals({ lat, lng, radiusMi, filter, nrows: rows, start: 0 });
  const total = first.total;
  if (first.stubs.length < rows || total <= rows) {
    return { stubs: dedupeByCrd(first.stubs), total, truncatedBy: null, pagesFetched: 1 };
  }

  // How deep we intend to go, bounded by the ceiling and by FINRA's own paging window.
  const reachable = Math.min(total, config.finra.maxStart + rows);
  const wanted = Math.min(ceiling, reachable);
  const starts = [];
  for (let start = rows; start < wanted; start += rows) starts.push(start);

  // PARALLEL, not sequential. This is what makes full-radius coverage affordable: FINRA
  // orders geo results by nearest-ZIP COHORT, so page 1 is 100 people from one ZIP and the
  // next suburb over may not appear until position 1,000+. Walking those pages one at a time
  // costs ~800ms each (17s for a 2,000-person radius); fetching them concurrently makes the
  // whole radius ~2-3s, and the cache absorbs it after the first caller.
  const pages = await pooled(starts, (start) =>
    searchIndividuals({ lat, lng, radiusMi, filter, nrows: rows, start }).catch(() => null),
  );

  const stubs = dedupeByCrd([first, ...pages.filter(Boolean)].flatMap((page) => page.stubs));

  let truncatedBy = null;
  if (total > reachable) truncatedBy = "finraPagingWindow";
  else if (wanted < reachable) truncatedBy = "candidateCeiling";

  return { stubs: stubs.slice(0, ceiling), total, truncatedBy, pagesFetched: 1 + starts.length };
}

/** One person, one row.
 *
 *  FINRA returns a separate hit per MATCHING BRANCH, so an adviser registered at two
 *  offices inside the radius comes back twice — and the caller sees the same name twice in
 *  one list. We keep the first occurrence, which is the one FINRA ranked nearest. */
function dedupeByCrd(stubs) {
  const seen = new Set();
  return stubs.filter((stub) => {
    if (!stub?.crd || seen.has(stub.crd)) return false;
    seen.add(stub.crd);
    return true;
  });
}

/** ③ Resolve a branch ZIP to coordinates via FINRA's own location resolver.
 *
 *  These are ZIP centroids, and we label them as such. FINRA's branch coordinates are
 *  ZIP centroids too — verified: /search/locations?query=98033 and the branch record for
 *  4000 Carillon Point both return exactly 47.673156,-122.197628 — so this costs no
 *  accuracy versus reading them off the detail payload, and it costs far fewer calls. */
async function locateZip(zip) {
  if (!zip) return null;
  const key = String(zip).slice(0, 5);
  if (!/^\d{5}$/.test(key)) return null;
  return branchGeoCache.wrap(`zip:${key}`, async () => {
    const resolved = await resolveLocation(key);
    return resolved ? { lat: resolved.lat, lng: resolved.lng, geoPrecision: GEO_PRECISION.ZIP_CENTROID } : null;
  });
}

/** ④ Attach distance and sort.
 *
 *  Secondary sort matters more than it looks: with ZIP-centroid coordinates everyone in
 *  the same ZIP has an IDENTICAL distance, so without a tiebreak the order inside a ZIP
 *  is arbitrary. Most-experienced-first is the defensible default — it is the ordering a
 *  user looking for an adviser would choose, and it is stable across requests. */
function rankStubs(stubs, origin) {
  return stubs
    .map((stub) => {
      const loc = stub._location;
      const meters = loc ? haversineMeters(origin.lat, origin.lng, loc.lat, loc.lng) : null;
      const geoPrecision = loc?.geoPrecision || GEO_PRECISION.UNKNOWN;
      const { _location, ...rest } = stub;
      return {
        ...rest,
        distanceMeters: presentDistance(meters, geoPrecision),
        distanceMiles: meters == null ? null : Math.round((meters / 1609.344) * 100) / 100,
        distanceApproximate: geoPrecision !== GEO_PRECISION.ROOFTOP,
        geoPrecision,
        location: loc ? { lat: loc.lat, lng: loc.lng } : null,
      };
    })
    .sort((a, b) => {
      // Unlocatable advisers sink to the bottom rather than pretending to be at distance 0.
      if (a.distanceMeters == null) return b.distanceMeters == null ? a.crd.localeCompare(b.crd) : 1;
      if (b.distanceMeters == null) return -1;
      if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters;
      const byExperience = (b.yearsExperience ?? -1) - (a.yearsExperience ?? -1);
      if (byExperience !== 0) return byExperience;
      // Final tiebreak on CRD makes the ordering TOTALLY deterministic. Without it, people
      // with an identical distance and identical experience could land in either order, so a
      // cache expiry between page 1 and page 2 would reshuffle them — and a client walking
      // offsets would see the same person twice and silently miss another.
      return a.crd.localeCompare(b.crd);
    });
}

/** ⑤ Full profile for one CRD, read-through cached.
 *
 *  Adviser-only individuals (bcScope "NotInScope") are enriched from the SEC's IAPD mirror,
 *  because BrokerCheck genuinely does not hold their experience or disclosures — its own site
 *  renders "For Disclosures and Years of Experience visit SEC" for exactly these people. One
 *  extra call, only for them, and a failure degrades to the BrokerCheck-only record. */
export async function hydrate(crd) {
  return profileCache.wrap(`crd:v${SCHEMA_VERSION}:${crd}`, async () => {
    const profile = buildProfile(crd, await fetchIndividualDetail(crd));
    const adviserOnly = String(profile.brokerScope || "").toLowerCase() === "notinscope";
    if (!config.iapd.enrich || !adviserOnly) return profile;
    const iapd = await fetchIndividualDetailIAPD(crd).catch(() => null);
    return mergeIapdProfile(profile, iapd);
  });
}

/** Full firm record, read-through cached. */
export async function hydrateFirm(firmId) {
  return firmCache.wrap(`firm:v${SCHEMA_VERSION}:${firmId}`, async () => buildFirmProfile(firmId, await fetchFirmDetail(firmId)));
}

/** Attach employer contact details (phone, office address) to a set of results.
 *
 *  An individual's FINRA payload has a branch street address but NO phone number — contact
 *  details only exist at firm level. Advisers cluster into a handful of employers, so this
 *  costs one call per DISTINCT firm, not per person, and the firm cache makes it ~free
 *  after the first query in an area. */
export async function attachFirmContact(rows) {
  const firmIds = [...new Set(rows.map((r) => r.firm?.firmId || r.firmId).filter(Boolean))];
  if (!firmIds.length) return rows;

  const firms = await pooled(firmIds, (id) => hydrateFirm(id).catch(() => null));
  const byId = new Map(firmIds.map((id, i) => [id, firms[i]]));

  for (const row of rows) {
    const firm = byId.get(row.firm?.firmId || row.firmId);
    if (!firm) continue;
    const summary = {
      firmName: firm.firmName,
      phone: firm.contact.phone,
      officeAddress: firm.contact.officeAddress,
      firmType: firm.firmType,
      firmSize: firm.firmSize,
      hasDisclosures: firm.hasDisclosures,
      reportUrl: firm.reportUrl,
    };
    if (row.firm) row.firm = { ...row.firm, ...summary };
    else Object.assign(row, summary);
  }
  return rows;
}

/** Ask FINRA only for the COUNT at a radius. One page of one row — the cheapest possible
 *  probe, and the basis for choosing a radius without paying for a full fetch at each. */
async function probeTotal({ lat, lng, radiusMi, filter }) {
  const page = await searchIndividuals({ lat, lng, radiusMi, filter, nrows: 1, start: 0 });
  return page.total;
}

/** How many candidates we fetch before ranking — deliberately INDEPENDENT of `limit`.
 *
 *  Scaling this with limit was a real bug. FINRA orders geo results by nearest-ZIP cohort,
 *  so fetching 300 for a limit=10 request doesn't sample the radius — it returns only the
 *  three nearest ZIPs, and suburbs well inside the radius become unreachable no matter how
 *  the caller pages. Measured at Kirkland r=5: limit=10 saw 3 ZIPs, limit=500 saw 8.
 *  Coverage is a property of the RADIUS, not of how many rows the caller wants to display.
 *
 *  Keeping it constant also means limit=10 and limit=500 share one cache entry, so the
 *  expensive fetch happens once per area rather than once per page size. */
function candidateBudget() {
  return config.search.candidateCeiling;
}

/** Resolve + rank candidates. Returns the frozen ordering; details hydrate afterwards. */
export async function resolveCandidates(query) {
  const { lat, lng, radiusMi, type, status, minExperienceYears } = query;
  const filter = buildFilter({ type, status, minExperienceYears });
  const ceiling = candidateBudget();
  // Ceiling is part of the key: a cached 100-candidate run must not satisfy a later
  // request that needs 500.
  const cacheKey = `v${SCHEMA_VERSION}|${geohash(lat, lng, 6)}|${radiusMi}|${filter}|${ceiling}`;

  const cached = queryCache.get(cacheKey);
  if (cached) return { ...cached, cache: "warm" };

  const { stubs, total, truncatedBy, pagesFetched } = await fetchCandidates({ lat, lng, radiusMi, filter, ceiling });

  // ② + ③: one lookup per distinct ZIP, not per person.
  const zips = [...new Set(stubs.map((s) => s.firm?.branchZip).filter(Boolean).map((z) => String(z).slice(0, 5)))];
  const located = await pooled(zips, (zip) => locateZip(zip));
  const byZip = new Map(zips.map((zip, i) => [zip, located[i]]));

  for (const stub of stubs) {
    const zip = stub.firm?.branchZip ? String(stub.firm.branchZip).slice(0, 5) : null;
    stub._location = zip ? byZip.get(zip) || null : null;
  }

  const ranked = rankStubs(stubs, { lat, lng });
  const result = {
    ranked,
    total,
    truncatedBy,
    uniqueLocations: zips.length,
    radiusMi,
    filter,
    cache: "cold",
    pagesFetched,
  };
  queryCache.set(cacheKey, result);
  return result;
}

/** Density guard. Manhattan returns 74,928 individuals within ONE mile because
 *  wirehouses register thousands of reps to a single HQ address. Rather than truncate
 *  silently, shrink the radius until the count is workable and report what we did. */
export async function resolveWithAutoTighten(query) {
  const filter = buildFilter(query);
  let radiusMi = query.radiusMi;
  const attempts = [];

  if (config.search.autoTighten) {
    // Choose the radius with cheap count-only probes FIRST, then fetch once. Fetching at
    // every candidate radius is what made this slow: each full fetch is up to ten round
    // trips, while a probe is one.
    for (let i = 0; i < 4; i++) {
      const total = await probeTotal({ ...query, radiusMi, filter });
      attempts.push({ radiusMi, total });
      if (total <= config.search.densityCeiling || radiusMi <= 0.5) break;
      // Scale by area: halving the radius quarters the area, the right first guess.
      radiusMi = Math.max(0.5, Math.round((radiusMi / 2) * 10) / 10);
    }
  }

  const result = await resolveCandidates({ ...query, radiusMi });
  return { ...result, radiusRequested: query.radiusMi, radiusAdjusted: radiusMi !== query.radiusMi, attempts };
}

/** Group ranked advisers by branch office. In dense metros a person-level "10 nearest"
 *  is 10 indistinguishable names from one lobby; the branch view is what makes that
 *  legible. In sparse areas this is close to a no-op. */
export function groupByBranch(ranked) {
  const groups = new Map();
  for (const person of ranked) {
    const key = `${person.firm?.firmId || "?"}|${person.firm?.branchZip || "?"}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        firmId: person.firm?.firmId || null,
        firmName: person.firm?.firmName || null,
        city: person.firm?.branchCity || null,
        state: person.firm?.branchState || null,
        zip: person.firm?.branchZip || null,
        distanceMeters: person.distanceMeters,
        distanceMiles: person.distanceMiles,
        distanceApproximate: person.distanceApproximate,
        geoPrecision: person.geoPrecision,
        location: person.location,
        advisorCount: 0,
        advisors: [],
      };
      groups.set(key, group);
    }
    group.advisorCount++;
    if (group.advisors.length < 5) group.advisors.push(person);
  }
  return [...groups.values()];
}

export const radiusMeters = (mi) => milesToMeters(mi);
