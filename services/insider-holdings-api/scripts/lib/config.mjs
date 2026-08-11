/**
 * Configuration. Env-var driven, no secrets in code.
 *
 * Every upstream this service reads is free and public: the SEC's own quarterly
 * Form 3/4/5 datasets, EDGAR's submissions API, and the Census ZCTA gazetteer.
 * There is no paid vendor anywhere in the chain and no credential to leak beyond
 * the optional bearer key that gates our own /v1 routes.
 */

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * The SEC requires a descriptive User-Agent with a contact address on every
 * automated request and returns 403 without one. This is not optional politeness;
 * it is their published access condition.
 */
export const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT || "Hushh Technologies insider-holdings-api ops@hushh.ai";

export const config = Object.freeze({
  port: num("PORT", 8080),
  apiKey: process.env.INSIDER_API_KEY || "",

  dataDir: process.env.INSIDER_DATA_DIR || "./data",

  sec: Object.freeze({
    userAgent: SEC_USER_AGENT,
    submissionsBase: "https://data.sec.gov/submissions",
    datasetBase: "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets",
    // 2026q2 moved under a new path when the SEC reorganised its data pages. Both are
    // tried in order, newest layout first, so a path change degrades to a slower fetch
    // rather than a hard failure.
    datasetBaseAlt:
      "https://www.sec.gov/files/datastandardsinnovation/data/insider-transactions-data-sets",
    // SEC asks for no more than 10 requests/second. We stay well under.
    requestsPerSecond: num("SEC_RPS", 5),
    timeoutMs: num("SEC_TIMEOUT_MS", 15000),
  }),

  search: Object.freeze({
    defaultRadiusMi: num("DEFAULT_RADIUS_MI", 25),
    maxRadiusMi: num("MAX_RADIUS_MI", 500),
    defaultLimit: num("DEFAULT_LIMIT", 25),
    maxLimit: num("MAX_LIMIT", 100),
  }),

  rateLimit: Object.freeze({
    perMinute: num("RATE_LIMIT_PER_MINUTE", 30),
    burst: num("RATE_LIMIT_BURST", 10),
    trustedProxyCount: num("TRUSTED_PROXY_COUNT", 1),
  }),

  /**
   * Staleness. The SEC publishes these datasets quarterly, so a 100-day-old index is
   * normal and a 200-day-old one means an ingest was missed. /health reports the age
   * either way rather than silently serving an old quarter as if it were current.
   */
  staleAfterDays: num("STALE_AFTER_DAYS", 200),
});
