// Env-driven config. No secrets in code; every value has a working default so the
// service runs locally with zero setup (FINRA's public API needs no credentials).

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 8080),

  // Bearer key for /v1/*. Supplied at deploy time from Secret Manager
  // (hushh-tech-prod / brokercheck-api-key). Empty = fully open endpoint, which is still a
  // supported mode — the per-IP rate limiter below bounds abuse either way.
  apiKey: String(process.env.BROKERCHECK_API_KEY || "").trim(),

  finra: {
    // Verified 2026-08-04. Note the /search prefix on the DETAIL path too:
    // GET /individual/{crd} (without /search) returns 403 — a path error, not a ban.
    searchBase: process.env.FINRA_SEARCH_BASE || "https://api.brokercheck.finra.org/search",
    // FINRA's own ZIP/city -> lat,lng resolver. Handy, undocumented, unauthenticated.
    locationsPath: "/locations",

    // Hard API limits, established by probing. Exceeding either returns HTTP 200 with
    // {"errorCode":-1,"errorMessage":"Exceeded limit","hits":null} — never a 4xx/5xx,
    // so the BODY is the only reliable error signal. See finra.mjs assertNotLimited().
    maxRows: 100, // nrows: 101+ fails
    maxStart: 8500, // start: 8500 ok, 9000 fails — so ~8600 records reachable per query

    timeoutMs: num(process.env.FINRA_TIMEOUT_MS, 20_000),
    // Validated from the GCE VM: 10 rapid requests all returned 200, so datacenter egress
    // is not treated differently. 16 is what makes full-radius coverage (~20 pages) land in
    // ~2-3s. NOTE: this is CPU-sensitive — on e2-small the same fan-out took 18s.
    concurrency: num(process.env.FINRA_CONCURRENCY, 16),
    gapMs: num(process.env.FINRA_GAP_MS, 0),
    retries: num(process.env.FINRA_RETRIES, 2),
  },

  iapd: {
    // The SEC's Investment Adviser Public Disclosure mirror. BrokerCheck's own SPA falls back
    // here for adviser-only individuals, whose experience and disclosures it does not hold.
    searchBase: process.env.IAPD_SEARCH_BASE || "https://api.adviserinfo.sec.gov/search",
    // Enrich adviser-only profiles from IAPD. Costs one extra call for those individuals only.
    enrich: process.env.IAPD_ENRICH !== "false",
  },

  search: {
    defaultRadiusMi: num(process.env.DEFAULT_RADIUS_MI, 10),
    maxRadiusMi: num(process.env.MAX_RADIUS_MI, 100),
    defaultLimit: num(process.env.DEFAULT_LIMIT, 50),
    maxLimit: num(process.env.MAX_LIMIT, 500),
    defaultBatchSize: num(process.env.DEFAULT_BATCH_SIZE, 10),

    // How many advisers we pull before ranking. This is a COVERAGE setting, not just a cost
    // one: FINRA orders geo results by nearest-ZIP cohort, so a low ceiling doesn't return "a
    // sample of the radius" — it returns only the nearest ZIPs and makes whole suburbs
    // structurally invisible. Measured at Kirkland r=5: positions 0-299 are Kirkland ZIPs,
    // while Bellevue 98004 (well inside the radius) doesn't appear until position ~1000.
    // Pages are fetched in parallel, so a higher ceiling costs round-trips, not wall-clock.
    candidateCeiling: num(process.env.CANDIDATE_CEILING, 3000),
    autoTighten: process.env.AUTO_TIGHTEN !== "false",
    // Auto-tighten only in GENUINELY extreme density. This was previously derived from
    // candidateCeiling (=4,000) and fired far too eagerly: Kirkland at 10 miles has 4,437
    // advisers — an ordinary suburban result — and got silently shrunk to 5 miles. The user
    // then compares our count against BrokerCheck's website, sees a completely different
    // number, and reasonably concludes the API is broken.
    //
    // Branch grouping (groupThreshold) already solves "10 names from one lobby", so
    // tightening is only needed where even the branch list would be unusable — Manhattan
    // scale. Respect the radius the caller asked for everywhere else.
    densityCeiling: num(process.env.DENSITY_CEILING, 20_000),
    // groupBy=auto switches to branch-mode above this many advisers in the radius.
    // Calibrated against live counts: Kirkland ~2.1k stays person-mode (you want names),
    // San Francisco ~7k and Manhattan ~15k become branch-mode (names would be 10 people
    // from one lobby).
    groupThreshold: num(process.env.GROUP_THRESHOLD, 5000),
  },

  rateLimit: {
    // Per-IP token bucket. This is what replaces an API key for a public endpoint.
    perMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 30),
    burst: num(process.env.RATE_LIMIT_BURST, 10),
  },
};

/** Attribution required by BrokerCheck Terms of Use §5 for any redistribution of this data.
 *  Emitted on every response so a consuming UI cannot forget it. */
export const ATTRIBUTION = {
  source: "FINRA BrokerCheck",
  sourceUrl: "https://brokercheck.finra.org",
  termsUrl: "https://brokercheck.finra.org/terms-and-conditions",
  notice:
    "Data retrieved from FINRA BrokerCheck. Use of BrokerCheck data is subject to the BrokerCheck Terms of Use.",
  errorReporting: "https://www.finra.org/investors/investing/working-with-investment-professional/about-brokercheck",
};
