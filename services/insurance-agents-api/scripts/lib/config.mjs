// Env-driven config.
//
// The upstream — Nationwide's own agency locator `search-api` — is KEYLESS (confirmed live:
// a bare GET returns 200 with the full result set). So there is NO upstream secret. The only
// secret is OUR bearer key, which gates who may call THIS service.
//
// Caveat that shapes the client: the locator sits behind Akamai + Cloudflare bot protection,
// so requests must look like a real browser (User-Agent + Referer) and be paced. Our caching
// means we hit Nationwide rarely (roughly once per area per day), which is what keeps us
// comfortably under any rate threshold.

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 8080),

  // Bearer key for /v1/*. From Secret Manager at deploy time. Empty = open (still rate-limited).
  apiKey: String(process.env.INSURANCE_AGENTS_API_KEY || "").trim(),

  nationwide: {
    // Keyless. Verified: GET .../search-api?q=<zip>&agencyName=&product= → 200 JSON.
    searchApi: process.env.NATIONWIDE_SEARCH_API || "https://agency.nationwide.com/search-api",
    // Behind Akamai — a browser-shaped UA + Referer is required for a reliable 200.
    userAgent:
      process.env.NATIONWIDE_UA ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    referer: process.env.NATIONWIDE_REFERER || "https://agency.nationwide.com/search",
    resultsPerPage: 50, // the API's page size (resultsPerPage in the payload)
    timeoutMs: num(process.env.NATIONWIDE_TIMEOUT_MS, 20_000),
    // Deliberately LOW concurrency + a small gap: Akamai punishes bursts, and the cache means
    // we rarely need many pages live anyway. Politeness first.
    concurrency: num(process.env.NATIONWIDE_CONCURRENCY, 3),
    gapMs: num(process.env.NATIONWIDE_GAP_MS, 300),
    retries: num(process.env.NATIONWIDE_RETRIES, 2),
  },

  search: {
    defaultLimit: num(process.env.DEFAULT_LIMIT, 25),
    maxLimit: num(process.env.MAX_LIMIT, 200),
    defaultBatchSize: num(process.env.DEFAULT_BATCH_SIZE, 10),
    // How many agencies we pull before ranking. The API returns a wide distance-ranked set
    // (704 for one Kirkland ZIP), so this caps pages fetched. milesToQueryLocation lets the
    // caller filter by radius after the fact.
    candidateCeiling: num(process.env.CANDIDATE_CEILING, 150),
    // Optional client-side radius filter (miles). null = no filter (return the nearest N).
    defaultRadiusMi: num(process.env.DEFAULT_RADIUS_MI, 0) || null,
    maxRadiusMi: num(process.env.MAX_RADIUS_MI, 500),
  },

  rateLimit: {
    perMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 30),
    burst: num(process.env.RATE_LIMIT_BURST, 10),
  },
};

/** Attribution — Nationwide's agency locator. A consuming UI should credit the source. */
export const ATTRIBUTION = {
  source: "Nationwide Agency Locator",
  sourceUrl: "https://agency.nationwide.com",
  notice: "Agency data retrieved from the Nationwide agency locator.",
};
