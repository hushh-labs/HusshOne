// RIA Identity API — phone number -> firm -> "which one of these is you?".
//
// An investment adviser types their office phone into our onboarding form. We match it to a
// FIRM and list the advisers publicly registered at that firm, so the adviser can point at
// their own row and claim it.
//
// EVERY SOURCE IS LIVE. There is no snapshot file anywhere in this service:
//   firm   — Cloud SQL `ria.firms` (SEC Form ADV feed), cross-checked against Google Places
//            resolved through IAPD firm search;
//   people — SEC IAPD, fetched on every request, always.
// The people rule is not a preference. The `advisers` table in the same database holds one
// of the four advisers IAPD currently lists at firm CRD 2907; the other three have no row.
// A roster served from it would tell real advisers they do not exist.
//
// MINIMAL DISCLOSURE BEFORE VERIFICATION. This is a DISAMBIGUATION AID for someone claiming
// their OWN profile — not an identity-resolution service, and not a reverse-phone lookup.
// Four things follow from that, and all four are load-bearing:
//   1. We return only what the SEC already publishes at adviserinfo.sec.gov. Nothing is
//      inferred, enriched, or joined against any other source.
//   2. Every /v1/* response carries verificationRequired:true. The integrating front-end MUST
//      send a one-time passcode to the number that was entered and treat the profile as
//      claimed only once the claimant proves possession. Our answer narrows the question;
//      the OTP answers it.
//   3. The per-minute bucket AND the per-day cap exist to make bulk enumeration of the
//      number space impractical. They are a product constraint, not a cost control — and
//      they are keyed on an address the CALLER CANNOT CHOOSE (see http.mjs clientIp).
//      EVERY disclosing route is charged, and that is now structural: routes.mjs declares
//      what each route discloses and its dispatch() is the only thing here that runs a
//      handler, so a route cannot be served without paying the cap first.
//   4. NO ROUTE RETURNS A PERSON NAME AS A FIRM FACT. /v1/firms/{crd} publishes the firm's
//      own filing and a Schedule A person COUNT, never the people. CRDs are small sequential
//      integers, and a route that named them could be walked into a national directory of
//      RIA owners and officers.
//
// Shape follows the sibling services (brokercheck-api, insurance-agents-api) on purpose:
// /health and /v1/stats open, bearer gate then rate limit on /v1/* only, NDJSON/SSE/buffered
// streaming, cache snapshot warmed before listen and saved on shutdown.

import http from "node:http";
import crypto from "node:crypto";
import { config, ATTRIBUTION } from "./scripts/lib/config.mjs";
import {
  allCacheStats,
  loadSnapshot,
  saveSnapshot,
  startSnapshotTimer,
  persistenceStatus,
  profileCache,
  firmCache,
  queryCache,
  SCHEMA_VERSION,
} from "./scripts/lib/cache.mjs";
import { parseQuery, parseSearchQuery, parseEvaluateQuery, parseEvaluateBody, QueryError } from "./scripts/lib/query.mjs";
import { evaluateClaim, ClaimError, SIGNALS as CLAIM_SIGNALS, EVIDENCE_TYPES, CLAIM_EVIDENCE_NOTICE } from "./scripts/lib/claim.mjs";
import { RateLimiter } from "./scripts/lib/rate-limit.mjs";
import { clientIp, statusForError, DailyCap, UpstreamBudget, selectHydrationTargets } from "./scripts/lib/http.mjs";
import { createStore } from "./scripts/lib/sql-store.mjs";
import * as iapd from "./scripts/lib/iapd.mjs";
import * as places from "./scripts/lib/places.mjs";
import { resolveByPhone, searchByName, explain, buildFirmDetail, loadClaimContext, toIndividualClaim } from "./scripts/lib/resolve.mjs";
import { matchRoute, dispatch, assertHandlersComplete } from "./scripts/lib/routes.mjs";

const SERVICE = "ria-identity-api";
const limiter = new RateLimiter(config.rateLimit);
const dailyCap = new DailyCap(config.rateLimit.dailyLookupCap);

/** Who the daily cap counts against. With a key configured the KEY is the accountable
 *  party (an integrator who needs more asks for more, consciously); open mode has no
 *  principal, so it falls back to the caller address. The key itself is never used as a map
 *  value or logged — a fingerprint identifies it without putting the secret anywhere it
 *  could leak through /v1/stats. */
const KEY_FINGERPRINT = config.apiKey
  ? `key:${crypto.createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12)}`
  : null;
const callerIp = (request) => clientIp(request, config.security.trustedProxyCount);
const capIdentity = (request) => KEY_FINGERPRINT || `ip:${callerIp(request)}`;

// ---------------------------------------------------------------------------
// Startup state
// ---------------------------------------------------------------------------

/** Cloud SQL, reached through the Auth Proxy. Constructing this opens NOTHING — the pool is
 *  created lazily on the first query — so a database that is down cannot stop us booting.
 *  /health reports its reachability honestly instead. */
const store = createStore({ db: config.db });

/** The four iapd.mjs caches, named after the call each one backs.
 *
 *  iapd.mjs read-throughs anything with a `.wrap(key, produce)`, so these are the concrete
 *  TtlCache instances from cache.mjs — NOT the module namespace. `individual` and `firm`
 *  are persisted across restarts (people and firms change on a timescale of weeks);
 *  rosters and name searches deliberately are not, since they are the volatile, cheap
 *  thing to rebuild.
 *
 *  NOTHING GOOGLE-DERIVED IS CACHED HERE. Under the Maps Platform terms only a place_id may
 *  be persisted, and places.mjs keeps its own 60-second module-local memo that saveSnapshot()
 *  structurally cannot reach. */
const caches = {
  individual: profileCache, // 7d,  persisted — iapd.getIndividual
  firm: firmCache, //         30d, persisted — iapd.getFirm
  roster: queryCache, //      6h              — iapd.listFirmIndividuals
  search: queryCache, //      6h              — iapd.searchIndividualsByName
  schemaVersion: SCHEMA_VERSION,
};

/** Transport options for iapd.mjs, so the env-driven values in config.mjs actually reach the
 *  upstream client instead of it silently falling back to its own module defaults. The user
 *  agent and the pacing gap are threaded here — both used to be config values nothing read,
 *  which made our SEC-facing identity unconfigurable in practice. */
const iapdOpts = (cache) => ({
  base: config.iapd.searchBase,
  timeoutMs: config.iapd.timeoutMs,
  retries: config.iapd.retries,
  userAgent: config.iapd.userAgent,
  gapMs: config.iapd.gapMs,
  cache,
});

const IAPD_OPTS = {
  individual: iapdOpts(caches.individual),
  firm: iapdOpts(caches.firm),
  roster: iapdOpts(caches.roster),
  search: iapdOpts(caches.search),
};

/** Options for the live Places -> IAPD firm-resolution chain. The IAPD side of that chain
 *  gets the same transport as everything else; the Google side gets the key and a timeout.
 *
 *  `iapd.cache` IS the persisted firm cache, and that is correct for what it now backs: IAPD
 *  FIRM DETAIL, keyed `iapd:firm:<crd>` and holding SEC public record. It is NOT used for the
 *  IAPD FIRM SEARCH in that chain — those queries are built out of the Google `displayName`,
 *  so places.mjs overrides the cache for them with its own memory-only store that
 *  saveSnapshot() cannot reach. See the ToS block at the top of places.mjs. */
const PLACES_OPTS = {
  apiKey: config.places.apiKey,
  timeoutMs: config.places.timeoutMs,
  iapd: {
    base: config.iapd.searchBase,
    timeoutMs: config.iapd.timeoutMs,
    retries: config.iapd.retries,
    userAgent: config.iapd.userAgent,
    gapMs: config.iapd.gapMs,
    cache: caches.firm,
  },
};

/** Built once at startup and handed to resolve.mjs on every call.
 *  - store    : the live Cloud SQL Form ADV firm table. FIRMS ONLY, never people.
 *  - places   : the live phone -> business -> CRD chain.
 *  - iapd     : the iapd.mjs module namespace — the ONLY source of people.
 *  - cache    : the named TtlCache instances above.
 *  - iapdOpts : ready-made opts bundles, one per iapd call, so resolve.mjs cannot forget the
 *               cache or rebuild the transport config by hand. */
const deps = {
  store,
  places,
  placesOpts: PLACES_OPTS,
  iapd,
  cache: caches,
  config,
  iapdOpts: IAPD_OPTS,
};

console.log(
  JSON.stringify({
    event: "sources.configured",
    service: SERVICE,
    db: store.describe,
    placesConfigured: Boolean(config.places.apiKey),
    iapdBase: config.iapd.searchBase,
    trustedProxyCount: config.security.trustedProxyCount,
  }),
);

// ---------------------------------------------------------------------------

/** name -> handler, one per entry in routes.mjs ROUTES. Handlers do the work and nothing else:
 *  the auth gate, the token bucket and the daily cap all happen before dispatch() calls them,
 *  which is what stops a new route from quietly shipping uncharged. */
const HANDLERS = {
  health: ({ response }) => handleHealth(response),
  stats: ({ response }) => handleStats(response),
  "claim.lookup": ({ request, response, started }, params, query) => handleLookup(request, response, started, query),
  "claim.search": ({ response }, params, query) => handleSearch(response, query),
  // One handler, two route entries (GET and POST) — the difference is only where the evidence
  // arrived, and by the time we are here both have been parsed into the same shape.
  "claim.evaluate": ({ response, started }, params, query) => handleEvaluate(response, started, query),
  "claim.evaluate.post": ({ response, started }, params, query) => handleEvaluate(response, started, query),
  "advisor.detail": ({ response }, { crd }) => handleAdvisor(response, crd),
  "firm.detail": ({ response }, { crd }) => handleFirm(response, crd),
};
assertHandlersComplete(HANDLERS);

/** Query parsing, run by dispatch() BEFORE the daily cap is charged. Both of these only parse
 *  and reject — no upstream call, no disclosure — which is what makes it safe for them to run
 *  ahead of the cap, and is why a caller's typo comes back 400 without costing them quota. */
const VALIDATORS = {
  "claim.lookup": ({ url }) => parseQuery(url.searchParams),
  "claim.search": ({ url }) => parseSearchQuery(url.searchParams),
  "claim.evaluate": ({ url }) => parseEvaluateQuery(url.searchParams),
  // Reading the body here — before the cap — is safe under the same rule that lets the other
  // validators run early: it parses and rejects, and it neither discloses nor calls upstream.
  // It also means a malformed JSON body is a 400 that costs the caller no quota.
  "claim.evaluate.post": async ({ request }) => parseEvaluateBody(await readJsonBody(request)),
};

/** Read and parse a JSON request body, with a hard size ceiling.
 *
 *  The ceiling is not a nicety: without one, a caller can hold a request open and stream
 *  megabytes into memory before anything has looked at a single field, and this route sits
 *  behind an optional bearer gate that may be open in a supported deployment mode. 64 KB is
 *  three orders of magnitude above the largest legitimate body (a claim type, two CRDs and a
 *  handful of evidence items). */
const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.destroy();
      throw new QueryError(`The request body must be ${MAX_BODY_BYTES} bytes or fewer.`, "body");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new QueryError(`The request body is not valid JSON: ${error.message}`, "body");
  }
}

const server = http.createServer(async (request, response) => {
  const started = Date.now();
  try {
    const url = new URL(request.url || "/", "http://localhost");

    // ONE match, up front. Everything below reads the route's own declaration instead of
    // re-deriving "is this a disclosing path?" from the string at three different places.
    const found = matchRoute(request.method, url.pathname);
    const route = found?.route ?? null;
    // An unmatched /v1/* path is still treated as protected: with a key configured, probing
    // for routes must not be free just because the probe missed.
    const underV1 = url.pathname.startsWith("/v1/");

    // Optional bearer gate. Empty key (the default) means open — but once a key IS
    // configured we fail CLOSED, so setting one actually protects something. /health and
    // /v1/stats declare requiresAuth:false: an uptime probe that needed a secret would be one
    // more thing to get wrong at 3am, and stats publishes aggregates only.
    if (config.apiKey && (route ? route.requiresAuth : underV1)) {
      if (String(request.headers.authorization || "") !== `Bearer ${config.apiKey}`) {
        return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      }
    }

    if (route ? route.rateLimited : underV1) {
      const allowed = limiter.take(callerIp(request));
      if (!allowed.ok) {
        response.setHeader("retry-after", String(allowed.retryAfterSec));
        return sendJson(response, 429, { ok: false, error: "Rate limit exceeded", retryAfterSec: allowed.retryAfterSec });
      }
    }

    if (!route) return sendJson(response, 404, { ok: false, error: "Not found", service: SERVICE });

    // THE CHOKE POINT. dispatch() charges the daily cap for every disclosing route before it
    // will run that route's handler — see routes.mjs.
    await dispatch({
      route,
      params: found.params,
      handlers: HANDLERS,
      validators: VALIDATORS,
      context: { request, response, url, started },
      charge: () => chargeDailyCap(request, response),
      onCapExceeded: (day) => sendDailyCapExceeded(response, day),
    });
    return;
  } catch (error) {
    // A ClaimError is the evidence engine rejecting a malformed CLAIM the same way QueryError
    // rejects a malformed QUERY — the caller's input, not our fault, so 400 not 502.
    const status = statusForError(error, { isQueryError: error instanceof QueryError || error instanceof ClaimError });
    if (response.headersSent) {
      // Mid-stream: emit a terminal error frame rather than truncating silently, in the
      // SAME framing the client is already parsing — a bare NDJSON line written into an SSE
      // stream is a frame the client will never see.
      try {
        const frame = { type: "error", error: message(error), verificationRequired: true };
        response.write(
          response.__streamMode === "sse"
            ? `event: error\ndata: ${JSON.stringify(frame)}\n\n`
            : `${JSON.stringify(frame)}\n`,
        );
      } catch {}
      return response.end();
    }
    return sendJson(response, status, {
      ok: false,
      error: message(error),
      type: error?.name || "Error",
      // Which input to highlight, so the form can point at the offending field.
      field: error?.field ?? null,
    });
  }
});

/** GET /v1/stats — open, aggregate counters only. */
function handleStats(response) {
  return sendJson(response, 200, {
    ok: true,
    service: SERVICE,
    uptimeSec: Math.round(process.uptime()),
    caches: allCacheStats(),
    cacheRoles: config.cache.roles,
    persistence: persistenceStatus(),
    sources: {
      firm: { formAdv: store.describe, places: { configured: Boolean(config.places.apiKey) } },
      people: {
        iapd: config.iapd.searchBase,
        // People come from IAPD and only from IAPD. The caches below hold IAPD's own
        // responses for a short time; there is no local table of advisers anywhere in
        // this service, which is the distinction that matters.
        fromLocalAdviserTable: false,
        rosterCacheTtl: config.cache.roles.query.ttl,
        profileCacheTtl: config.cache.roles.profile.ttl,
      },
    },
    rateLimit: {
      perMinute: config.rateLimit.perMinute,
      burst: config.rateLimit.burst,
      trackedIps: limiter.size,
      trustedProxyCount: config.security.trustedProxyCount,
    },
    // THE CLAIM POLICY, published. An integrator building the front end needs to know which
    // signals exist, which of them it may assert, and what each one actually proves — and it
    // should be able to read that from the running service rather than from a README that
    // drifted. Aggregates and vocabulary only; no claim, evidence or person appears here.
    claimPolicy: {
      modes: ["auto", "firm", "individual"],
      claimTypes: ["individual", "firm"],
      thresholds: {
        individual: "phone_otp AND (sole_adviser OR email_name_match OR oidc_name_match)",
        firm: "phone_otp AND (adv_officer OR (domain_email AND the claimant is on the live roster))",
      },
      signals: Object.fromEntries(
        Object.entries(CLAIM_SIGNALS).map(([name, signal]) => [
          name,
          { proves: signal.proves, assertable: signal.assertable, label: signal.label, note: signal.note },
        ]),
      ),
      assertableEvidence: EVIDENCE_TYPES,
      notice: CLAIM_EVIDENCE_NOTICE,
    },
    // Aggregate only — never per-identity usage, which would let an unauthenticated
    // caller read the state of an authenticated one from this open route.
    dailyLookupCap: dailyCap.status,
    upstreamBudget: {
      perRequest: config.lookup.maxUpstreamCallsPerRequest,
      profileCallsPerRequest: config.lookup.maxProfileCallsPerRequest,
    },
    attribution: ATTRIBUTION,
  });
}

/** GET /health — open, and honest about every live dependency.
 *
 *  `ok` stays true while the process is serving. A probe that flapped because a downstream
 *  was slow would restart a working instance and fix nothing; the per-source booleans are
 *  what an operator actually reads. There is no index to report any more.
 *
 *  THE DATABASE BLOCK COMES FROM store.health(), not from ping(). Cloud SQL is OPTIONAL here:
 *  a deployment that deliberately runs without it resolves phone -> firm on the live
 *  Places/IAPD chain and is fully functional. ping() answers `ok:null` in that case, and the
 *  old rendering turned that into "Cloud SQL is unreachable — check the Cloud SQL Auth Proxy",
 *  which pages someone at 3am about a proxy that was never supposed to exist. health() returns
 *  two DIFFERENT shapes — `{configured:false, ...}` and `{configured:true, reachable, ...}` —
 *  so "switched off" and "not answering" can never be rendered as each other. */
async function handleHealth(response) {
  const [db, freshness] = await Promise.all([store.health(), store.freshness()]);
  return sendJson(response, 200, {
    ok: true,
    service: SERVICE,
    timestamp: new Date().toISOString(),
    sources: {
      formAdvDb: db,
      places: {
        configured: Boolean(config.places.apiKey),
        note: Boolean(config.places.apiKey)
          ? "Live business lookup enabled. Only placeId may ever be persisted."
          : "No PLACES_API_KEY: the live cross-check is skipped and every response says so.",
      },
      iapd: {
        base: config.iapd.searchBase,
        live: true,
        note: "Rosters and person profiles come from SEC IAPD, through a short read-through cache of IAPD's own responses. No adviser is ever read from a local adviser table.",
      },
    },
    freshness,
    hints: [
      // Only a database we were ASKED to use can be "unreachable". `configured:false` is a
      // supported standalone deployment and gets an informational line, not an alarm.
      db.configured === false ? "No Cloud SQL Form ADV table is configured. Phone -> firm resolves live from Google Places cross-validated through SEC IAPD; this is a supported standalone mode, not an outage." : null,
      db.configured && db.reachable === false
        ? "Cloud SQL is unreachable — check the Cloud SQL Auth Proxy. Phone lookups fall back to the live Places path only."
        : null,
      freshness.stale ? `The Form ADV firm feed is ${freshness.ageDays ?? "an unknown number of"} days old (stale after ${freshness.staleAfterDays}). Check the directories ingest job.` : null,
      config.places.apiKey ? null : "PLACES_API_KEY is unset, so no firm match can be corroborated by a live business listing.",
    ].filter(Boolean),
  });
}

/** GET /v1/claim/lookup — the main endpoint.
 *
 *  `query` is already parsed and the daily cap already charged, both by dispatch() (see
 *  routes.mjs): validation rejects a typo with a 400 before the cap is touched, and the cap is
 *  charged before one byte of disclosure or one upstream call. */
async function handleLookup(request, response, started, query) {
  // One budget for the whole request. resolve.mjs spends it on the Places chain and the
  // roster pages; whatever survives is what profile hydration may use.
  const budget = new UpstreamBudget(config.lookup.maxUpstreamCallsPerRequest);
  const emit = makeEmitter(response, query.stream);

  // resolve.mjs never throws on an IAPD failure — it degrades to firm-only and says so in
  // each candidate's .reasons — so anything that escapes here is genuinely our bug.
  const result = await resolveByPhone(query.phone, {
    ...deps,
    budget,
    detail: query.detail,
    limit: query.limit,
    // See MODES in query.mjs. It narrows the SHAPE of the answer and can never widen the
    // disclosure: individualClaims is a projection of the candidate list the resolver already
    // decided on, and that decision never sees `mode`.
    mode: query.mode,
  });

  const firms = result.firms || [];
  // Belt and braces: the resolver honours deps.limit, but this is the disclosure ceiling
  // and it is enforced where the bytes actually leave the process.
  const candidates = (result.candidates || []).slice(0, query.limit);

  emit({
    type: "meta",
    service: SERVICE,
    query: result.query,
    outcome: result.outcome,
    confidence: result.confidence,
    nextStep: result.nextStep,
    // The step the person-only flow would have taken, kept alongside the dual-identity one so
    // a front-end built before `choose_identity` existed still has the field it reads.
    personNextStep: result.personNextStep ?? result.nextStep,
    mode: result.mode ?? query.mode,
    modeNote: result.modeNote ?? null,
    // THE DUAL-IDENTITY PAIR. One phone number legitimately belongs to a firm AND to every
    // adviser registered there, so both claim targets travel in the meta frame and the human
    // says which is theirs. We never guess between them.
    firmClaim: result.firmClaim ?? null,
    claimTargets: result.claimTargets ?? null,
    // One plain-English sentence the UI can render above the pick-list without composing
    // its own copy from the outcome enum.
    explanation: explain(result),
    // `large_firm` covers two very different situations and the UI has to tell them apart:
    // a real wirehouse switchboard, and a small private-fund adviser whose people simply
    // have no record in IAPD's individual index. Measured over 50 random indexed numbers,
    // 15 of the 17 large_firm results were the SECOND kind — so shipping only the enum
    // would have the front end saying "too many advisers" about a two-person shop.
    // currentAdviserCount 0 (with no rosterError) is that case; `notes` carries the prose.
    currentAdviserCount: result.currentAdviserCount ?? null,
    // IAPD's raw match count INCLUDES former employees, so it is named for what it is and
    // never presented as a roster size.
    rosterMatchesIncludingFormer: result.rosterMatchesIncludingFormer ?? null,
    rosterTruncated: result.rosterTruncated ?? null,
    rosterError: result.rosterError ?? null,
    notes: result.notes || [],
    firmCount: firms.length,
    candidateCount: candidates.length,
    firmMatch: result.firmMatch ?? null,
    // Where each fact came from, and how old the Form ADV mapping is.
    sources: result.sources ?? null,
    freshness: result.freshness ?? null,
    detail: query.detail,
    limit: query.limit,
    verificationRequired: true,
    attribution: ATTRIBUTION,
  });

  for (const firm of firms) emit({ type: "firm", firm });

  let emitted = candidates;
  let hydration = null;
  if (query.detail && candidates.length) {
    // Copy before hydrating: the resolver's candidates may come from a cached roster, and
    // attaching a profile to a cached object would leak it into every later response.
    emitted = candidates.map((candidate) => ({ ...candidate }));
    // Two ceilings the caller does not control: a config maximum, and whatever is left of
    // this request's upstream budget. Candidates with no CRD are skipped rather than fetched
    // — there is nothing to fetch, and asking used to surface an internal validation string
    // to the caller as `profileError`.
    const plan = selectHydrationTargets(emitted, { max: config.lookup.maxProfileCallsPerRequest, budget });
    for (const candidate of plan.skipped) {
      candidate.profileSkipped = "No SEC individual CRD is linked to this person, so there is no profile to load.";
    }
    await forEachLimited(plan.targets, config.iapd.concurrency, async (candidate) => {
      if (!budget.take(1)) {
        candidate.profileSkipped = "Upstream call budget for this request was exhausted before this profile could be loaded.";
        return;
      }
      try {
        candidate.profile = await iapd.getIndividual(candidate.individualCrd, IAPD_OPTS.individual);
      } catch (error) {
        // A profile that will not load must not cost the caller the pick-list.
        candidate.profileError = message(error);
      }
    });
    hydration = { requested: emitted.length, hydrated: plan.targets.length, capped: plan.capped, max: plan.allowed };
  }

  // Every candidate goes out as an INDIVIDUAL CLAIM TARGET — same person, same fields, plus
  // claimType and `claimable`. A Schedule A fallback entry has no individual CRD, so it is
  // published with claimable:false: it exists so the claimant recognises the firm, and there is
  // no SEC profile behind it to hand over.
  emitted.forEach((candidate, i) => emit({ type: "candidate", rank: i + 1, candidate: toIndividualClaim(candidate) }));

  emit({
    type: "done",
    ms: Date.now() - started,
    outcome: result.outcome,
    nextStep: result.nextStep,
    firms: firms.length,
    candidates: emitted.length,
    hydration,
    upstream: budget.status,
    verificationRequired: true,
  });
  return end(response, query.stream);
}

/** GET /v1/claim/search — the fallback when the phone misses (a mobile, a new office line,
 *  a firm whose Form ADV lists a different number). Not streamed, but it is NOT one upstream
 *  call: it is a name search plus one profile fetch per row it hydrates. Measured before the
 *  fix, `?name=smith&limit=50` made 51 requests to the SEC against a configured ceiling of 24,
 *  because searchByName ignored the budget built here. It spends it now.
 *
 *  This route NAMES PEOPLE, so it is charged against the daily cap exactly like the phone
 *  path — dispatch() does that before this function runs (routes.mjs). It was not, and a
 *  name-driven route is just as walkable as a number-driven one. */
async function handleSearch(response, query) {
  const budget = new UpstreamBudget(config.lookup.maxUpstreamCallsPerRequest);
  const found = await searchByName(query.name, { ...deps, budget, state: query.state, limit: query.limit });
  // Tolerate a bare array as well as the documented object, so a shape change upstream
  // degrades to "fewer fields" rather than `{"0":{...},"1":{...}}`.
  const payload = Array.isArray(found) ? { candidates: found } : found || {};
  const candidates = (payload.candidates || []).slice(0, query.limit);

  return sendJson(response, 200, {
    ok: true,
    ...payload,
    query: { name: query.name, state: query.state },
    candidates,
    total: payload.total ?? candidates.length,
    upstream: budget.status,
    verificationRequired: true,
    attribution: ATTRIBUTION,
  });
}

/**
 * GET|POST /v1/claim/evaluate — THE POLICY ENDPOINT.
 *
 * WHAT THIS DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT.
 *
 * It does not send a one-time passcode. It does not send an email. It cannot see an SMS or a
 * mailbox and it never will. What it does is define and score the POLICY: given the checks the
 * integrator's own backend says it performed, is that enough to hand over this profile, and if
 * not, what is the single cheapest thing left to do?
 *
 * THE TRUST BOUNDARY IS THE WHOLE DESIGN, so it is stated in the response as well as here.
 * Evidence must be asserted by a server-side BFF from checks it performed itself. If a browser
 * can reach this endpoint with evidence of its own choosing, the model is defeated completely —
 * a claimant simply asserts `phone_otp` and takes any profile they like. No threshold in
 * claim.mjs can detect that, because the assertion is the only thing it has. The mitigation is
 * architectural and it belongs to the integrator: keep this endpoint behind their backend, and
 * derive every assertion from a check that backend actually ran.
 *
 * The firm and the roster are read HERE, from the SEC, and are never accepted from the caller.
 * That is what stops the other obvious attack: asserting a roster of one so that elimination
 * hands over the profile.
 */
async function handleEvaluate(response, started, query) {
  const budget = new UpstreamBudget(config.lookup.maxUpstreamCallsPerRequest);
  const context = await loadClaimContext(query.firmCrd, { ...deps, budget });

  if (!context.firm) {
    return sendJson(response, 404, {
      ok: false,
      error: `No SEC-registered advisory firm was found for CRD ${query.firmCrd}, so there is nothing here to claim.`,
      firmCrd: query.firmCrd,
      sources: context.sources,
      verificationRequired: true,
      attribution: ATTRIBUTION,
    });
  }

  // AWAITED. evaluateClaim is async because oidc_name_match runs through vertex.mjs's guarded
  // matcher — deterministic first, and a model only ever confirms-or-vetoes a single index the
  // deterministic guard already narrowed to. Without the await, `result` would be a Promise and
  // this route would answer `{}` with a 200.
  const result = await evaluateClaim({
    claimType: query.claimType,
    firm: context.firm,
    roster: context.roster,
    selectedIndividualCrd: query.individualCrd,
    evidence: query.evidence,
  });

  // ── POSSESSION-GATED ROSTER ────────────────────────────────────────────────────────────────
  // /v1/claim/lookup withholds names above a headcount threshold, because an ANONYMOUS caller
  // who can type phone numbers must not be able to walk this into a reverse-phone directory of
  // advisers. That gate is right for an anonymous caller and wrong for this one: reaching here
  // with an ACCEPTED phone_otp means the caller answered the number this firm filed with the
  // SEC. Someone who can answer a firm's phone is entitled to see who works there — it is
  // published on adviserinfo.sec.gov, and they can read it there in a browser.
  //
  // So the gate moves from HEADCOUNT to POSSESSION. Below the threshold nothing changes. Above
  // it, a 9-, 11- or 40-adviser firm becomes claimable, which it was not before: its advisers
  // are exactly the target market and they were the ones locked out.
  //
  // The anonymous endpoint is untouched, so this widens nothing for a caller who has not
  // proven possession, and the daily cap still applies.
  const otpAccepted = (result.evidenceLedger || []).some(
    (row) => row.signal === "phone_otp" && row.accepted === true,
  );

  return sendJson(response, 200, {
    ...result,
    firm: context.firmSummary,
    // Present ONLY once possession is proven. `null` is "not unlocked", never "this firm has
    // nobody" — a caller must be able to tell those apart.
    rosterUnlocked: otpAccepted,
    roster: otpAccepted
      ? (context.roster || []).map((person) => ({
          individualCrd: person.individualCrd ?? person.crd ?? null,
          name: person.name ?? null,
          branchCity: person.branchCity ?? null,
          branchState: person.branchState ?? null,
          hasDisclosures: person.hasDisclosures ?? null,
          profileUrl: person.individualCrd
            ? `https://adviserinfo.sec.gov/individual/summary/${person.individualCrd}`
            : null,
          claimType: "individual",
        }))
      : null,
    rosterNote: otpAccepted
      ? "Full current roster, unlocked because the passcode was answered on the number this firm filed with the SEC. Render it as the pick-list. Selecting a row is INTENT, not identity — the claim is still provisional until an identity signal lands."
      : "Roster withheld: no accepted phone_otp on this evaluation. Prove possession of the firm's filed number to unlock the pick-list.",
    ms: Date.now() - started,
    // A roster we could not read is reported, not hidden. It fails CLOSED — every identity
    // signal is derived by matching against the roster, so an empty one derives nothing and
    // allowed comes back false. That is the safe direction, and it is also indistinguishable
    // from "this person really is not registered here", which is why the caller is told which
    // sources answered rather than being left to infer it from a bare refusal.
    rosterConsulted: context.sources.iapdRoster.present,
    currentAdviserCount: context.currentAdviserCount,
    sources: context.sources,
    warnings: context.errors.length
      ? [
          `A source did not answer (${context.errors.join("; ")}). This verdict fails closed — an unread roster derives no identity, so a REFUSAL here may be our dependency failing rather than a fact about the claimant. Retry before telling anyone they could not be verified.`,
        ]
      : [],
    upstream: budget.status,
    verificationRequired: true,
    attribution: ATTRIBUTION,
  });
}

/**
 * GET /v1/advisors/{crd} — ONE NAMED ADVISER'S PUBLIC SEC PROFILE.
 *
 * This is the most disclosing route in the service: it turns a small sequential integer into a
 * named person. It shipped OUTSIDE the daily cap — the cap's own docstring claimed every
 * disclosing route shared it, and this route was the counter-example — so the individual index
 * could be walked for free. It is charged now, by dispatch(), because routes.mjs declares it
 * `discloses: person` and nothing can run a handler without going through there.
 */
async function handleAdvisor(response, crd) {
  const individual = await iapd.getIndividual(crd, IAPD_OPTS.individual);
  return sendJson(response, 200, { ok: true, individual, verificationRequired: true, attribution: ATTRIBUTION });
}

/**
 * GET /v1/firms/{crd} — FIRM-LEVEL FACTS ONLY.
 *
 * This route used to return the whole indexed record, which included the firm's Schedule A
 * persons array: every direct owner and executive officer by name, title and ownership band.
 * Confirmed against the shipped build — /v1/claim/lookup on J.P. Morgan (CRD 79) deliberately
 * withheld all 15 of them and returned a count, and then GET /v1/firms/79 handed back all 15
 * with their titles. CRDs are small sequential integers, so the route could be walked to
 * reconstruct a national directory of RIA owners and officers. It was also outside the daily
 * cap and carried no verificationRequired.
 *
 * All four are fixed here: the response is the same firm projection the lookup path publishes
 * (no person names, a Schedule A COUNT), the daily cap is charged (by dispatch, before this
 * runs), and verificationRequired travels with it.
 */
async function handleFirm(response, crd) {
  const [filed, live, freshness] = await Promise.all([
    store.getFirm(crd).catch((error) => ({ __error: message(error) })),
    // The HTTP status travels with the error, because 404 ("the SEC has no such firm") is an
    // ANSWER and anything else is a dependency failure. buildFirmDetail needs to tell them
    // apart before it decides between 404 and 503.
    iapd.getFirm(crd, IAPD_OPTS.firm).catch((error) => ({ __error: message(error), __status: Number(error?.status) || null })),
    store.freshness(),
  ]);

  const filedError = filed?.__error ?? null;
  const liveError = live?.__error ?? null;

  // The whole body is built by buildFirmDetail in resolve.mjs, where a unit test can reach
  // it. This route deliberately owns no shaping logic of its own — that is exactly how the
  // Schedule A array leaked out of here in the first place.
  const { status, body } = buildFirmDetail({
    crd,
    filed: filedError ? null : filed,
    live: liveError ? null : live,
    filedError,
    liveError,
    liveStatus: live?.__status ?? null,
    // A database that is switched off returns null from getFirm without ever being asked.
    // "We did not look" must never be reported to a caller as "there is no such firm".
    filedConsulted: store.enabled !== false,
    filedSkipped: store.enabled === false ? "not_configured" : null,
    freshness,
    attribution: ATTRIBUTION,
    deps,
  });
  return sendJson(response, status, body);
}

/** Charge one unit of the daily cap and stamp the headers.
 *
 *  Called from exactly ONE place: dispatch() in routes.mjs, for every route the table declares
 *  as disclosing a firm or a person. That is what makes the sentence above true rather than
 *  aspirational — it used to be called from two of the four disclosing route sites, and
 *  /v1/advisors/{crd} and /v1/claim/search were the two it missed. */
function chargeDailyCap(request, response) {
  const day = dailyCap.take(capIdentity(request));
  response.setHeader("x-ratelimit-daily-limit", String(day.limit));
  response.setHeader("x-ratelimit-daily-remaining", String(day.remaining ?? 0));
  return day;
}

function sendDailyCapExceeded(response, day) {
  response.setHeader("retry-after", String(day.retryAfterSec));
  return sendJson(response, 429, {
    ok: false,
    error: `Daily lookup cap reached (${day.limit} per day). This endpoint is a claim-your-own-profile aid, not a bulk phone-number lookup, and the cap is what keeps it that way. If you have a legitimate need for more volume, ask for your own key and cap.`,
    dailyLimit: day.limit,
    used: day.used,
    resetsAt: day.resetsAt,
    retryAfterSec: day.retryAfterSec,
  });
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
  // Recorded so the mid-stream error handler can frame its terminal error correctly.
  response.__streamMode = mode;
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
    return sendJson(response, 200, {
      ok: true,
      meta: frames.find((f) => f.type === "meta") || {},
      firms: frames.filter((f) => f.type === "firm").map((f) => f.firm),
      candidates: frames.filter((f) => f.type === "candidate").map((f) => f.candidate),
      // The dual-identity pair, named as such for a caller that does not want to reach into
      // meta. `individualClaims` is the SAME array as `candidates` — one list, two names, so
      // there is no chance of the two drifting apart and disclosing different sets.
      firmClaim: (frames.find((f) => f.type === "meta") || {}).firmClaim ?? null,
      individualClaims: frames.filter((f) => f.type === "candidate").map((f) => f.candidate),
      done: frames.find((f) => f.type === "done") || null,
      verificationRequired: true,
      attribution: ATTRIBUTION,
    });
  }
  return response.end();
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

// Warm from the last snapshot BEFORE accepting traffic, so a restart does not dump every
// in-flight caller onto the cold path at once.
const warm = await loadSnapshot();
console.log(JSON.stringify({ event: "cache.restored", service: SERVICE, ...warm }));
startSnapshotTimer(config.cache.snapshotIntervalMs);

/**
 * OPEN THE DATABASE CONNECTION BEFORE THE FIRST USER NEEDS IT.
 *
 * MEASURED, on a cold process against Cloud SQL through the Auth Proxy: the FIRST
 * lookupByPhone spends its whole 800ms request deadline establishing the pg connection and
 * comes back `status:"timeout", consulted:false`. The resolver handles that correctly — it
 * publishes "the Form ADV table did not answer, so its answer is unknown, not empty" and falls
 * back to the live Places chain — but the answer is genuinely worse. Phone 212-969-1000 resolved
 * to ALLIANCEBERNSTEIN CORPORATION (CRD 107445) on the second request of a process and to
 * `no_match` on the first, because Places alone could not disambiguate it.
 *
 * On Cloud Run with min-instances 0 that is not an edge case: it is the experience of the first
 * adviser to arrive after every scale-to-zero. One throwaway query at boot moves the connection
 * cost off the user's request.
 *
 * FIRE AND FORGET, DELIBERATELY. It is not awaited and its failure is logged rather than thrown:
 * Cloud SQL is optional here (see config.db), and a service that refused to start because an
 * optional dependency was down would be a worse service than one that starts degraded and says
 * so on /health.
 */
store
  .health()
  .then((health) => console.log(JSON.stringify({ event: "db.warmed", service: SERVICE, reachable: health?.reachable ?? null, latencyMs: health?.latencyMs ?? null })))
  .catch((error) => console.warn(JSON.stringify({ event: "db.warm_failed", service: SERVICE, error: message(error) })));

server.listen(config.port, () => {
  console.log(JSON.stringify({ event: "server.started", service: SERVICE, port: config.port }));
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (shuttingDown) return; // a second Ctrl-C must not race the snapshot write
    shuttingDown = true;
    console.log(JSON.stringify({ event: "server.stopping", service: SERVICE, signal }));
    // Hard deadline first: a hung save must never turn a restart into a kill -9.
    const deadline = setTimeout(() => process.exit(0), 10_000);
    deadline.unref();
    try {
      const saved = await saveSnapshot();
      console.log(JSON.stringify({ event: "cache.snapshot_saved", ...saved }));
    } catch (error) {
      console.warn(JSON.stringify({ event: "cache.snapshot_failed", error: error.message }));
    }
    try {
      await store.close();
    } catch {}
    server.close(() => process.exit(0));
  });
}
