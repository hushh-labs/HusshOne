// Env-driven config. No secrets in code.
//
// WHAT THIS SERVICE IS: an adviser types their office phone into our onboarding form; we
// narrow it to their FIRM and list the advisers registered there so they can say "that's me"
// and claim their own profile.
//
// WHAT IT IS NOT: a reverse-phone-lookup or identity-resolution service. Almost every limit
// below exists to keep it the first thing and stop it becoming the second. Read the limits
// as product constraints, not as cost controls.
//
// ---------------------------------------------------------------------------
// EVERY SOURCE IS LIVE. There is no offline index any more.
// ---------------------------------------------------------------------------
// The service used to answer from a JSON snapshot of Form ADV built by a script. It no
// longer does, and the file is gone. Three live sources, in this order:
//
//   1. Cloud SQL (`ria`)  — OPTIONAL. The Form ADV firm table the directories crawler keeps
//                           current. Authoritative for phone -> firm, and it is a FIRM table
//                           only. Absent or switched off (RIA_DB_ENABLED), sources 2 and 3
//                           answer the whole question on their own — see the db block below.
//   2. Google Places      — live business identity for a phone number, cross-validated to a
//                           CRD through IAPD firm search (see places.mjs).
//   3. SEC IAPD           — the ROSTER and every PERSON PROFILE, on every request, always.
//
// Rule 3 is not a preference, it is a correctness requirement. The `advisers` table in the
// same database is measurably incomplete: firm CRD 2907 has four advisers currently
// registered at it according to IAPD, and the table holds exactly one of them — the other
// three have no row at all. Answering a person question from that table would tell a real
// adviser they do not exist. The table may be used for offline cross-checks and nothing else.

import { readFileSync } from "node:fs";

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Non-negative integer, so 0 is a legal configured value (it is, for trustedProxyCount). */
const int0 = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

/** A secret from either the env var or a file path in `${name}_FILE`.
 *
 *  The file form is what Cloud Run's secret mounts and local `gcloud secrets access > file`
 *  both produce, and it keeps the value out of the process environment (and therefore out of
 *  crash dumps and `ps`). A missing or unreadable file is an empty string, never a throw:
 *  every consumer of these already degrades gracefully, and refusing to boot would turn a
 *  mis-typed path into a full outage. */
function secret(name) {
  const inline = String(process.env[name] || "").trim();
  if (inline) return inline;
  const path = String(process.env[`${name}_FILE`] || "").trim();
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Cloud SQL: OPTIONAL, and optional means optional
// ---------------------------------------------------------------------------
//
// The Form ADV firm table is a SPEED-AND-CORROBORATION source, not a requirement. The live
// chain — Google Places -> IAPD firm search -> address cross-validation -> IAPD roster —
// answers the same question end to end with no database of ours in the loop at all. So a
// deployment with no Cloud SQL is a SUPPORTED STANDALONE MODE, not a degraded one, and
// nothing in this service may present it as an outage: no 5xx, no boot failure, no /health
// banner, and no confidence penalty on a match the live chain proved on its own.
//
// Three env knobs govern it:
//   RIA_DB_ENABLED     auto (default) | on | off
//   RIA_DB_PASSWORD    the secret; its presence is what "auto" reads
//   RIA_DB_HOST        an explicitly configured host also counts as "someone set this up"
//
// `auto` exists because the alternative is a footgun in both directions: defaulting to ON
// makes every laptop and every CI run look like a database outage, and defaulting to OFF
// would silently ignore a password an operator did set.

const TRUTHY = new Set(["1", "true", "yes", "on", "enable", "enabled"]);
const FALSY = new Set(["0", "false", "no", "off", "disable", "disabled"]);

/** RIA_DB_ENABLED -> "auto" | "on" | "off". Anything unrecognised is "auto": a typo must not
 *  silently switch a configured database off (nor force a nonexistent one on). */
function enabledMode(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "auto") return "auto";
  if (TRUTHY.has(value)) return "on";
  if (FALSY.has(value)) return "off";
  return "auto";
}

const DB_PASSWORD = secret("RIA_DB_PASSWORD");
// `host` has a default, so process.env is the only way to tell "an operator chose 127.0.0.1"
// from "nobody said anything". Only the former counts as configuration.
const DB_HOST_ENV = String(process.env.RIA_DB_HOST || "").trim();
const DB_MODE = enabledMode(process.env.RIA_DB_ENABLED);
/** Did anyone actually set a database up? */
const DB_CONFIGURED = Boolean(DB_PASSWORD) || Boolean(DB_HOST_ENV);
const DB_ENABLED = DB_MODE === "on" ? true : DB_MODE === "off" ? false : DB_CONFIGURED;

const DB_REASON =
  DB_MODE === "off"
    ? "RIA_DB_ENABLED is off: the Form ADV table is not consulted."
    : DB_MODE === "on"
      ? DB_CONFIGURED
        ? "RIA_DB_ENABLED is on."
        : "RIA_DB_ENABLED is on, but neither RIA_DB_PASSWORD nor RIA_DB_HOST is set — connections will fail and every lookup will fall back to the live chain."
      : DB_CONFIGURED
        ? `RIA_DB_ENABLED is auto and a database is configured (${DB_PASSWORD ? "RIA_DB_PASSWORD" : "RIA_DB_HOST"} is set).`
        : "RIA_DB_ENABLED is auto and no database is configured (neither RIA_DB_PASSWORD nor RIA_DB_HOST is set), so phone -> firm resolves live from Google Places and SEC IAPD only.";

export const config = {
  port: num(process.env.PORT, 8080),

  // Bearer key for /v1/*. Empty = open (still rate-limited and daily-capped), which is a
  // supported mode for local work. In production a key SHOULD be set: unlike the sibling
  // location-search services, this endpoint turns a phone number into NAMED PEOPLE, so the
  // key is what makes a caller accountable. When a key IS configured we fail CLOSED.
  apiKey: secret("RIA_IDENTITY_API_KEY"),

  // Cloud SQL `ria` — the live Form ADV firm table (hushh-tech-prod:us-central1:
  // hushh-directories-db). Reached through the Cloud SQL Auth Proxy in every environment,
  // so the host is always a loopback port and there is never a raw IP in config.
  //
  // OPTIONAL. A database that is absent, switched off, or will not answer is not fatal at
  // boot and is not an outage at request time: the live Places -> IAPD chain resolves a
  // phone on its own, and /health reports which of the three states we are in without ever
  // making "DB down" look like "service down".
  db: {
    // Resolved on/off, plus the raw switch and the evidence behind it, so /health and
    // /v1/stats can explain themselves instead of just showing a boolean.
    enabled: DB_ENABLED,
    enabledMode: DB_MODE, // "auto" | "on" | "off"
    configured: DB_CONFIGURED, // a password or an explicit host exists
    reason: DB_REASON,

    host: DB_HOST_ENV || "127.0.0.1",
    hostConfigured: Boolean(DB_HOST_ENV),
    port: num(process.env.RIA_DB_PORT, 5439),
    database: process.env.RIA_DB_NAME || "ria",
    user: process.env.RIA_DB_USER || "directories",
    password: DB_PASSWORD,
    poolMax: num(process.env.RIA_DB_POOL_MAX, 5),
    connectionTimeoutMs: num(process.env.RIA_DB_CONNECT_TIMEOUT_MS, 5_000),
    statementTimeoutMs: num(process.env.RIA_DB_STATEMENT_TIMEOUT_MS, 5_000),

    // THE REQUEST-SIDE DEADLINE, and the one that actually protects a caller.
    //
    // connectionTimeoutMs and statementTimeoutMs are pg's own, and they are five seconds
    // because they bound a broken socket, not a user's patience. A lookup must never wait
    // that long for a corroborating source: the live chain is already in flight in parallel
    // and is the answer either way. 800ms is ~3 orders of magnitude above the measured
    // indexed lookup (sub-millisecond through the proxy), so it fires only when something
    // is genuinely wrong. int0, not num, so 0 is a legal value meaning "no deadline".
    timeoutMs: int0(process.env.RIA_DB_TIMEOUT_MS, 800),
    // How long a Form ADV freshness reading is reused before we ask ingest_runs again.
    // The bulk feed lands daily at best, so a five-minute cache costs nothing.
    freshnessTtlMs: num(process.env.RIA_DB_FRESHNESS_TTL_MS, 300_000),
    // Past this age the mapping is labelled stale in `freshness` and in /health. It does not
    // stop us answering — an old Form ADV row is still a real filing — it makes the age
    // impossible for an integrator to overlook.
    staleAfterDays: num(process.env.RIA_DB_STALE_AFTER_DAYS, 14),
  },

  // Google Places (New). Used LIVE ONLY: of everything it returns, only `placeId` may ever
  // be persisted (see the ToS section at the top of places.mjs). Unset means the live
  // cross-check simply does not run and every response says so.
  places: {
    apiKey: secret("PLACES_API_KEY"),
    timeoutMs: num(process.env.PLACES_TIMEOUT_MS, 10_000),
  },

  // Gemini on Vertex AI — JUDGEMENT ONLY, NEVER A SOURCE OF FACTS.
  //
  // See the rule at the top of vertex.mjs. Every knob here is about whether we are allowed
  // to ASK a model to adjudicate between things the SEC already told us; none of it can
  // make a model the origin of a name, a CRD or a registration.
  //
  //   VERTEX_ENABLED   auto (default) | on | off. `auto` means "use it if credentials
  //                    happen to exist" — the module degrades to null on every failure, so
  //                    auto is safe on a laptop with no ADC and in CI with no network.
  //   VERTEX_PROJECT   falls back to the runtime's own project env vars, then to the GCE/
  //                    Cloud Run metadata server. Empty everywhere = not configured = off.
  //   VERTEX_LOCATION  `global`, MEASURED. The us-central1 regional endpoint 404s for every
  //                    gemini model id tried on this project; the global endpoint serves
  //                    them. Do not "fix" this to a region without re-measuring.
  //   VERTEX_TIMEOUT_MS  a lookup must never wait on judgement. 6s, then we fall back to
  //                    the deterministic path that would have answered anyway.
  vertex: (() => {
    const mode = enabledMode(process.env.VERTEX_ENABLED);
    const project = String(
      process.env.VERTEX_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        process.env.CLOUDSDK_CORE_PROJECT ||
        "",
    ).trim();
    return {
      enabled: mode !== "off",
      enabledMode: mode, // "auto" | "on" | "off"
      project,
      projectConfigured: Boolean(project),
      location: String(process.env.VERTEX_LOCATION || "global").trim() || "global",
      model: String(process.env.VERTEX_MODEL || "gemini-2.5-flash").trim() || "gemini-2.5-flash",
      timeoutMs: num(process.env.VERTEX_TIMEOUT_MS, 6_000),
      // How long an access token is reused. Google's are an hour; we keep 45 minutes and
      // refresh on any 401 anyway, so a revoked token costs one retry, not an outage.
      tokenTtlMs: num(process.env.VERTEX_TOKEN_TTL_MS, 2_700_000),
      // The metadata-server probe. Short on purpose: on a laptop it must fail fast and get
      // out of the way of `gcloud`, and on Cloud Run it answers in single-digit ms.
      metadataTimeoutMs: num(process.env.VERTEX_METADATA_TIMEOUT_MS, 500),
      reason:
        mode === "off"
          ? "VERTEX_ENABLED is off: no language model is consulted for any judgement."
          : project
            ? `Vertex may be consulted for judgement only, on project ${project}.`
            : "No Vertex project is configured (VERTEX_PROJECT / GOOGLE_CLOUD_PROJECT), so judgement calls are skipped and every caller falls back to its deterministic path.",
    };
  })(),

  iapd: {
    // SEC Investment Adviser Public Disclosure. Public, unauthenticated, no key.
    searchBase: process.env.IAPD_SEARCH_BASE || "https://api.adviserinfo.sec.gov/search",
    // Human-facing site — used to build the profileUrl we hand the UI, so a claimant can
    // verify against the SEC's own page rather than trusting our rendering of it.
    siteBase: process.env.IAPD_SITE_BASE || "https://adviserinfo.sec.gov",
    // Identify ourselves honestly and contactably on every upstream call. If the SEC ever
    // wants to throttle or reach us, they can do it without guesswork. This value is
    // THREADED THROUGH to the transport — it is not decorative.
    userAgent:
      process.env.IAPD_USER_AGENT || "hushh-ria-identity-api/0.1 (+https://hushh.ai; contact ankit@hushh.ai)",
    timeoutMs: num(process.env.IAPD_TIMEOUT_MS, 20_000),
    // Modest fan-out on purpose. One lookup touches one firm roster plus (with detail=true)
    // a handful of individuals — there is no wide geographic sweep to parallelise, so
    // politeness costs us nothing.
    concurrency: num(process.env.IAPD_CONCURRENCY, 6),
    // Minimum spacing between outbound IAPD requests, process-wide. 0 disables it. Also
    // threaded through to the transport.
    gapMs: int0(process.env.IAPD_GAP_MS, 0),
    retries: num(process.env.IAPD_RETRIES, 2),
    rosterPageSize: num(process.env.IAPD_ROSTER_PAGE_SIZE, 100),
    // Hard ceiling on roster paging for ONE lookup. IAPD pages at 100, and a wirehouse has
    // thousands of matches — we page far enough to count a small firm exactly and then stop,
    // reporting the truncation rather than pretending the page size was the roster.
    rosterMaxRows: num(process.env.IAPD_ROSTER_MAX_ROWS, 300),
  },

  lookup: {
    // Deliberately NOT env-overridable. These bound how many named people one phone number
    // can reveal in a single response, which is a disclosure decision, not a tuning knob —
    // an operator raising MAX_LIMIT to 500 would quietly turn a disambiguation aid into a
    // firm-roster dump. Change it here, in review, or not at all.
    defaultLimit: 10,
    maxLimit: 50,

    // Roster-size thresholds that decide the lookup outcome (see resolve.mjs):
    //   <= singlePersonMax   -> single_person  (one adviser at that number: just confirm)
    //   <= fewCandidatesMax  -> few_candidates (a short pick-list a human can scan)
    //   >  fewCandidatesMax  -> large_firm     (too many to list as "is this you?")
    singlePersonMax: 1,
    // RAISED FROM 5 TO 8, ON MEASURED EVIDENCE, AND STILL NOT ENV-OVERRIDABLE.
    //
    // 5 was a guess made before anyone had run the flow against a real small RIA. The
    // canonical case is ROBINSWOOD FINANCIAL LLC (firm CRD 143417, Kirkland WA), whose main
    // line 425-296-1611 is the working number of SEVEN currently registered advisers. At 5,
    // that firm fell into `large_firm` and the response named NOBODY — so the seven people
    // this service exists to serve were told, in effect, that their own office number
    // identifies no one, and were pushed to the name-entry fallback for a roster a human can
    // read at a glance.
    //
    // 8 is where "a short pick-list a human can scan" actually sits, and the gate it guards is
    // unchanged in kind: the thing that must never happen is a wirehouse switchboard returning
    // ten strangers, and a 40-, 60- or 3,388-adviser firm is as far above 8 as it was above 5.
    // Anything larger still names only advisers a real signal points at (Form ADV Schedule A),
    // and names nobody at all when there is no such signal.
    fewCandidatesMax: 8,

    // How many upstream calls ONE request may spend, total. The daily cap counts REQUESTS;
    // without this a single `detail=true&limit=50` request fans out to 50 profile fetches
    // plus roster pages plus the Places chain, so a caller inside their quota can still put
    // fifty times their share of load on the SEC. The budget is spent in priority order —
    // the firm and the roster first, profile hydration last — so exhausting it degrades the
    // response instead of breaking it.
    maxUpstreamCallsPerRequest: num(process.env.MAX_UPSTREAM_CALLS_PER_REQUEST, 24),
    // Of that budget, the most that may go on `detail=true` profile hydration.
    maxProfileCallsPerRequest: num(process.env.MAX_PROFILE_CALLS_PER_REQUEST, 10),
  },

  rateLimit: {
    // Per-caller token bucket — the burst control.
    perMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 30),
    burst: num(process.env.RATE_LIMIT_BURST, 10),

    // ANTI-BULK-ENUMERATION daily ceiling on the disclosing endpoints, on top of the
    // per-minute bucket. The bucket stops a burst; it does nothing about a patient crawler
    // walking the NANP number space at 30/minute (43,200 numbers/day) to build a phone ->
    // named-adviser map, which is precisely the abuse this endpoint's shape invites. A
    // legitimate onboarding flow spends ONE lookup per adviser, so a daily ceiling is nearly
    // free for the real use and fatal to the abusive one. Raise it consciously, per
    // integrator.
    dailyLookupCap: num(process.env.DAILY_LOOKUP_CAP, 2000),
  },

  security: {
    // How many proxies sit between the public internet and this process, COUNTING THE
    // DIRECT PEER. This is the only thing that makes the rate limit real.
    //
    // X-Forwarded-For is client-supplied at its LEFT end: every proxy APPENDS the address it
    // saw, so an attacker who sends `X-Forwarded-For: 1.1.1.1` gets `1.1.1.1, <their real
    // IP>` delivered to us. Reading index [0] therefore reads a value the attacker chose,
    // and rotating it resets both the token bucket and the daily cap — measured, 15/15
    // requests succeeded where 5 should have been refused.
    //
    // The client is the entry `trustedProxyCount` from the RIGHT:
    //   0 -> no proxy at all; ignore the header entirely and use the socket address.
    //   1 -> one trusted hop is the socket peer (bare Cloud Run / run.app). Client is the
    //        RIGHTMOST XFF entry — the one our own front end appended.
    //   2 -> Cloud Run behind an external HTTPS load balancer, which adds its own entry.
    // If the header is shorter than that, it has not been through the proxies we expect, so
    // we fall back to the socket address rather than trust it.
    trustedProxyCount: int0(process.env.TRUSTED_PROXY_COUNT, 1),
  },

  // cache.mjs is copied VERBATIM from services/brokercheck-api (generic infra, so fixes
  // port across services with a clean diff) and owns its own TTL constants. The entries
  // below name what each of its caches holds HERE and are surfaced on /v1/stats, so an
  // operator can read the numbers without opening the file.
  //
  // NOTE: no Google Places value is cached here or anywhere persistent. places.mjs keeps a
  // 60-second module-local memo that saveSnapshot() structurally cannot reach.
  cache: {
    snapshotPath: process.env.CACHE_SNAPSHOT_PATH || "/var/lib/ria-identity/cache-snapshot.json",
    snapshotIntervalMs: num(process.env.CACHE_SNAPSHOT_INTERVAL_MS, 300_000),
    roles: {
      profile: { holds: "IAPD individual profiles, keyed by CRD", ttl: "7d", persisted: true },
      firm: { holds: "IAPD firm detail, keyed by firm CRD", ttl: "30d", persisted: true },
      query: { holds: "firm rosters and name searches", ttl: "6h", persisted: false },
      branchGeo: { holds: "unused by this service", ttl: "never", persisted: true },
    },
  },
};

/** Attribution for the public data we serve, emitted on every /v1/* response so a consuming
 *  UI cannot forget where this came from — or that it is the SEC's record, not ours.
 *
 *  `retrievedAt` is a GETTER, not a boot-time constant: the roster and profile data are
 *  fetched live from IAPD as the request is served, so the retrieval date is the response
 *  date. Freezing it at process start would make a month-old pod claim month-old data was
 *  retrieved today. JSON.stringify invokes it, so every serialisation is honest. */
export const ATTRIBUTION = {
  source: "SEC Investment Adviser Public Disclosure (IAPD) and Form ADV public data",
  sourceUrl: "https://adviserinfo.sec.gov",
  get retrievedAt() {
    return new Date().toISOString();
  },
  notice:
    "Firm and adviser records are retrieved from the SEC's Investment Adviser Public Disclosure system (IAPD) and from public Form ADV filings. The SEC's own record at adviserinfo.sec.gov is authoritative.",
  // Repeated in the payload because it is the single most important thing an integrator can
  // get wrong: this response is a disambiguation aid, NOT proof of identity.
  verificationNotice:
    "This response identifies a firm and the advisers publicly registered at it. It does not verify that the caller is any of them. Send a one-time passcode to the number that was entered and only treat a profile as claimed once the claimant proves possession.",
  // Restated on the wire because the constraint travels with the data, not with the code
  // that fetched it.
  placesNotice:
    "Where a Google Places business record contributed to the firm match it is marked in `sources.places`. Under the Google Maps Platform terms only `placeId` may be stored; the business name, address, phone and website in that block are for live use in this response and must not be persisted.",
};
