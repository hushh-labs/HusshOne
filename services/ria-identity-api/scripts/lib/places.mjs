// Phone -> firm CRD, with NO snapshot anywhere in the path.
//
// The offline route (phone -> Form ADV index) is only ever as fresh as the last bulk build.
// This is the live one:
//
//    phone --[Google Places]--> business identity (name + street address)
//          --[SEC IAPD firm search]--> candidate firms
//          --[SEC IAPD firm detail]--> address cross-validation --> CRD + confidence
//
// Every hop is a live call. Nothing here reads our database.
//
// ---------------------------------------------------------------------------
// WHY THE CROSS-VALIDATION IS THE WHOLE POINT
// ---------------------------------------------------------------------------
// IAPD's firm search matches a firm's DBA list as well as its legal name, and it reports no
// score. Measured live 2026-08-06:
//
//   query "Nestlerode & Loy Investment Advisors"  -> total 1
//        -> CRD 144426 INTERNATIONAL ASSETS INVESTMENT MANAGEMENT, LLC (Orlando, FL)
//
// One hit. Zero ambiguity to a naive caller. Completely wrong — it matched one of that
// firm's 100 registered DBAs, and the firm we actually wanted (CRD 2907, State College PA)
// is not in the result set at all. Trusting `total === 1` would have handed an adviser a
// stranger's firm to claim.
//
// Two defences, both load-bearing:
//   1. QUERY VARIANTS. We ask IAPD more than once — the full business name, and shortened
//      forms built by dropping legal and generic industry words. "Nestlerode & Loy" and
//      "Nestlerode Loy" both return CRD 2907 cleanly. Results are pooled, not preferred by
//      query order.
//   2. ADDRESS SCORING. Every pooled candidate is scored against the address Places gave us
//      for that phone number. 144426 scores 0 (wrong name, wrong city, wrong state, wrong
//      ZIP); 2907 scores 165/165. A candidate below MIN_SCORE never yields a CRD — we return
//      the candidate list instead and let the UI ask a human.
//
// A geographic match alone is never sufficient: an office building holds many firms, so
// `requires a name signal` is enforced independently of the numeric threshold.
//
// ---------------------------------------------------------------------------
// GOOGLE MAPS PLATFORM ToS — READ BEFORE ADDING A CACHE
// ---------------------------------------------------------------------------
// Of everything Places returns, ONLY `place_id` may be persisted. The business name,
// formatted address, phone number and website are LIVE-USE ONLY: they may be put in the
// response we are currently serving, and then they must be forgotten. They must never be
// written to Postgres, never be written into an enrichment column, and never reach the
// on-disk cache snapshot.
//
// Concretely, in this service:
//   * `placesMemo` below is a MODULE-LOCAL Map with a 60s TTL. It is NOT one of cache.mjs's
//     caches, so it is structurally incapable of reaching saveSnapshot() — that function
//     serialises a fixed PERSISTED list (branchGeo, profile, firm) and this Map is not on it.
//     It exists only so one request that looks the number up twice pays for it once.
//   * getFirm() IS given the persisted firm cache, and that is fine: it caches SEC IAPD
//     data keyed by CRD, which is public record we are free to store. Places-derived values
//     are never passed into it. Keep it that way — the moment a Places field is used to build
//     a cache key or a cached value, the ToS line has been crossed.
//   * IAPD FIRM SEARCH IS THE PLACE THAT LINE WAS CROSSED. Its queries are built out of the
//     Google `displayName` (firmQueryVariants below) and iapd.mjs keys the cache on the query
//     string, so handing it the persisted firm cache wrote entries like
//     `iapd:firmsearch:nestlerode & loy investment advisors:10` into the on-disk snapshot with
//     a 30-day TTL. Google's business name, on disk, for a month. It now uses
//     `firmSearchMemo` below — a module-local, memory-only, 60-second store that saveSnapshot()
//     is structurally incapable of reaching — and the persisted cache passed in by the caller
//     is deliberately overridden for those calls and only those calls.
//   * `resolveByPhoneLive` marks the Places block `persistable: ["placeId"]` in its own
//     output so a downstream writer has no excuse for guessing.

import { normalizePhone } from "./phone.mjs";
import { getFirm, searchFirmsByName } from "./iapd.mjs";

export const PLACES_SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

/** Exactly the fields we use. A narrower mask is cheaper and keeps us from incidentally
 *  holding Places data we have no use for. */
export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
].join(",");

/** Stable reason codes. Safe to branch on. */
export const PLACES_REASON = {
  UNCONFIGURED: "places_unconfigured",
  INVALID_PHONE: "invalid_phone",
  NO_MATCH: "no_match",
  PHONE_MISMATCH: "phone_mismatch",
  ERROR: "places_error",
  NO_BUSINESS: "no_business",
  NO_CANDIDATES: "no_candidates",
  IAPD_ERROR: "iapd_error",
  BELOW_THRESHOLD: "below_threshold",
};

/** Cross-validation weights. Max 165. */
export const SCORE = {
  NAME: 50,
  CITY: 30,
  STATE: 20,
  ZIP: 25,
  ADDRESS: 40,
};
export const MAX_SCORE = SCORE.NAME + SCORE.CITY + SCORE.STATE + SCORE.ZIP + SCORE.ADDRESS;

/** Below this, we refuse to name a CRD and hand back candidates instead.
 *  95 is the floor of the weakest combination we are willing to stand behind:
 *  name (50) + state (20) + ZIP (25). Name + state alone is 70 and does not clear it. */
export const MIN_SCORE = 95;
/** name + city + state + ZIP all agreeing. Street confirmation pushes past it comfortably. */
export const HIGH_SCORE = 125;
/** Two candidates this close are not distinguishable by our evidence; say so rather than
 *  picking one. */
export const AMBIGUITY_MARGIN = 20;

const DEFAULT_TIMEOUT_MS = 8000;
/** How many pooled candidates get an authoritative getFirm() confirmation. The pool is
 *  pre-ranked on the address the search endpoint already embedded, so this is a confirmation
 *  budget, not a search budget. */
const DEFAULT_DETAIL_CHECKS = 3;
/** Distinct IAPD firm-search queries per lookup. */
const MAX_QUERY_VARIANTS = 3;
const DEFAULT_SEARCH_LIMIT = 10;
/** Pooling three fuzzy searches can yield 15+ hits, nearly all scoring 0. The list exists so
 *  a UI can ask "did you mean?", and a 15-item disambiguation prompt is not a question. */
const DEFAULT_MAX_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// memory-only, request-scale memo — see the ToS block above
// ---------------------------------------------------------------------------

const PLACES_MEMO_TTL_MS = 60_000;
const placesMemo = new Map();

function memoGet(key, now) {
  const entry = placesMemo.get(key);
  if (!entry) return undefined;
  if (entry.expires < now) {
    placesMemo.delete(key);
    return undefined;
  }
  return entry.value;
}

function memoSet(key, value, now, ttlMs) {
  if (ttlMs <= 0) return value;
  // Hard bound: this must never become a long-lived store of Places data.
  if (placesMemo.size >= 500) placesMemo.clear();
  placesMemo.set(key, { value, expires: now + ttlMs });
  return value;
}

/** Drop every cached Places value. Call on shutdown, or from a test. */
export function clearPlacesMemo() {
  placesMemo.clear();
  firmSearchMemo.clear();
}

// ---------------------------------------------------------------------------
// the IAPD firm-search cache — memory-only, because the KEY is Places-derived
// ---------------------------------------------------------------------------

/** How long a Places-derived IAPD firm search is reused. Long enough that one lookup's three
 *  query variants and a retry cost the SEC one round trip each; far too short to be a store of
 *  Google data. Never persisted, whatever the caller passes in. */
const FIRM_SEARCH_MEMO_TTL_MS = 60_000;
const firmSearchMemo = new Map();

/**
 * A `.wrap(key, produce)` cache that iapd.mjs can use exactly like one of cache.mjs's, and
 * that saveSnapshot() cannot see.
 *
 * This is the ONLY cache an IAPD firm search may be given from this module. cache.mjs
 * serialises a fixed PERSISTED list of TtlCache instances; this Map is not one of them and is
 * not on it, so "the query string reaches the disk" is not a rule someone has to remember —
 * there is no code path from here to a file.
 */
export const firmSearchCache = {
  name: "placesFirmSearch",
  persisted: false,
  async wrap(key, produce) {
    const now = Date.now();
    const entry = firmSearchMemo.get(key);
    if (entry && entry.expires > now) return entry.value;
    if (entry) firmSearchMemo.delete(key);
    const value = await produce();
    // Hard bound: this must never grow into a long-lived index of Google business names.
    if (firmSearchMemo.size >= 500) firmSearchMemo.clear();
    firmSearchMemo.set(key, { value, expires: now + FIRM_SEARCH_MEMO_TTL_MS });
    return value;
  },
};

// ---------------------------------------------------------------------------
// name normalisation
// ---------------------------------------------------------------------------

/** Removed outright: they carry no identity, and Places and the SEC disagree about them
 *  constantly ("NESTLERODE & LOY, INC." vs "Nestlerode & Loy Investment Advisors"). */
const LEGAL_TOKENS = new Set([
  "llc", "lllp", "llp", "lp", "inc", "incorporated", "corp", "corporation",
  "pllc", "plc", "pc", "ltd", "limited", "co",
]);

/** Kept in the normalised name (they are part of it) but NOT counted as identifying: tens of
 *  thousands of RIAs are an "Investment Advisors" or a "Wealth Management". A candidate that
 *  shares only these with the business is not a match, it is the industry. */
const GENERIC_TOKENS = new Set([
  "investment", "investments", "investing", "investor", "investors",
  "advisor", "advisors", "adviser", "advisers", "advisory",
  "wealth", "management", "managers", "manager", "asset", "assets",
  "capital", "financial", "finance", "group", "partners", "partner",
  "planning", "planners", "planner", "services", "service", "associates",
  "company", "holdings", "solutions", "strategies", "strategy", "strategic",
  "consulting", "consultants", "consultant", "trust", "securities",
  "retirement", "insurance", "agency", "firm", "office", "offices",
  "the", "and", "of", "for", "a", "an",
]);

/** Casefold, strip accents, drop punctuation and legal suffixes.
 *  "Yanni & Associates Investment Advisors, LLC" -> "yanni associates investment advisors"
 *  "NESTLERODE & LOY, INC."                      -> "nestlerode loy" */
export function normalizeFirmName(input) {
  const base = String(input ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // Periods first, so "L.L.C." collapses to "llc" instead of shattering into "l l c".
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ");

  return base
    .split(" ")
    .filter((t) => t && !LEGAL_TOKENS.has(t))
    .join(" ")
    .trim();
}

const tokensOf = (normalized) => (normalized ? normalized.split(" ").filter(Boolean) : []);

/** The tokens that actually identify a firm. */
export function distinctiveTokens(normalized) {
  return tokensOf(normalized).filter((t) => !GENERIC_TOKENS.has(t) && t.length > 1);
}

function isSubset(small, large) {
  return small.length > 0 && small.every((t) => large.includes(t));
}

/**
 * Name agreement, 0..SCORE.NAME.
 *
 * Returns 0 unless the two names share at least one DISTINCTIVE token — without that guard
 * "Smith Investment Advisors" and "Jones Investment Advisors" look like a 2/3 token overlap.
 */
export function scoreName(placesName, firmName) {
  const a = normalizeFirmName(placesName);
  const b = normalizeFirmName(firmName);
  if (!a || !b) return { score: 0, matched: false };

  const ta = tokensOf(a);
  const tb = tokensOf(b);
  const da = distinctiveTokens(a);
  const db = distinctiveTokens(b);

  // No shared identifying word -> no name evidence, whatever the generic overlap suggests.
  const sharedDistinctive = da.filter((t) => db.includes(t));
  if (sharedDistinctive.length === 0) return { score: 0, matched: false };

  // Exact, or one name is the other plus industry words: "nestlerode loy" inside
  // "nestlerode loy investment advisors".
  if (a === b || isSubset(ta, tb) || isSubset(tb, ta)) {
    return { score: SCORE.NAME, matched: true };
  }

  const shared = ta.filter((t) => tb.includes(t)).length;
  const dice = (2 * shared) / (ta.length + tb.length);
  return { score: Math.round(SCORE.NAME * dice), matched: dice >= 0.5 };
}

// ---------------------------------------------------------------------------
// address normalisation
// ---------------------------------------------------------------------------

/** Places writes "110 Regent Ct Ste 202"; the SEC writes "110 REGENT COURT, SUITE 202".
 *  Same building. Everything collapses to the short form. */
const STREET_ABBREV = new Map(Object.entries({
  street: "st", str: "st",
  avenue: "ave", av: "ave",
  boulevard: "blvd",
  court: "ct",
  drive: "dr",
  road: "rd",
  lane: "ln",
  place: "pl",
  parkway: "pkwy",
  highway: "hwy",
  turnpike: "tpke",
  circle: "cir",
  square: "sq",
  terrace: "ter",
  trail: "trl",
  center: "ctr", centre: "ctr",
  building: "bldg",
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
}));

/** Anything after one of these is a unit inside the building, not the building. */
const UNIT_TOKENS = new Set(["ste", "suite", "unit", "apt", "apartment", "fl", "floor", "rm", "room", "no", "num", "bldg", "building"]);

function normalizeStreetTokens(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((t) => STREET_ABBREV.get(t) ?? t);
}

/** The building, without the unit. Comparing this rather than the whole line is what makes
 *  "110 Regent Ct Ste 202" and "110 REGENT COURT, SUITE 202" agree — and also what lets a
 *  firm that only filed "110 Regent Court" still match. */
export function streetBase(input) {
  const tokens = normalizeStreetTokens(input);
  const cut = tokens.findIndex((t) => UNIT_TOKENS.has(t));
  const base = cut === -1 ? tokens : tokens.slice(0, cut);
  return base.join(" ").trim();
}

const normalizeCity = (input) =>
  String(input ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const normalizeState = (input) => {
  const s = String(input ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
};

/** ZIP+4 and ZIP compare on the 5-digit part — the +4 is a delivery route, not a location. */
const zip5 = (input) => {
  const m = String(input ?? "").match(/\d{5}/);
  return m ? m[0] : null;
};

/**
 * Split a Places formattedAddress into parts.
 *
 * "110 Regent Ct Ste 202, State College, PA 16801"
 *   -> { street: "110 Regent Ct Ste 202", city: "State College", state: "PA", zip: "16801" }
 *
 * Places sometimes appends ", USA"; regionCode:"US" usually suppresses it, but not always,
 * so it is stripped defensively rather than parsed as the state line.
 */
export function parseFormattedAddress(formattedAddress) {
  const empty = { street: null, city: null, state: null, zip: null };
  const raw = String(formattedAddress ?? "").trim();
  if (!raw) return empty;

  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^(usa|united states)$/i.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return empty;

  // Last part is "PA 16801" (or just "PA", or just a ZIP).
  const tail = parts[parts.length - 1];
  const tailMatch = tail.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);

  let state = null;
  let zip = null;
  let consumedTail = false;

  if (tailMatch) {
    state = tailMatch[1].toUpperCase();
    zip = tailMatch[2].slice(0, 5);
    consumedTail = true;
  } else if (/^[A-Za-z]{2}$/.test(tail)) {
    state = tail.toUpperCase();
    consumedTail = true;
  } else if (/^\d{5}(-\d{4})?$/.test(tail)) {
    zip = tail.slice(0, 5);
    consumedTail = true;
  }

  const rest = consumedTail ? parts.slice(0, -1) : parts;
  const city = rest.length >= 1 ? rest[rest.length - 1] : null;
  const street = rest.length >= 2 ? rest.slice(0, -1).join(", ") : null;

  return { street: street || null, city: city || null, state, zip };
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

/**
 * Cross-validate one IAPD firm against the live Places business.
 *
 * `address` is the firm's SEC-filed office address — from the search hit when we are
 * pre-ranking, from getFirm() when we are confirming.
 */
export function scoreCandidate(business, firmName, address) {
  const matchedOn = [];
  let score = 0;

  const name = scoreName(business?.name, firmName);
  if (name.score > 0) {
    score += name.score;
    if (name.matched) matchedOn.push("name");
  }

  const city = normalizeCity(business?.city);
  const state = normalizeState(business?.state);
  const zip = zip5(business?.zip);
  const street = streetBase(business?.street);

  if (city && normalizeCity(address?.city) === city) {
    score += SCORE.CITY;
    matchedOn.push("city");
  }
  if (state && normalizeState(address?.state) === state) {
    score += SCORE.STATE;
    matchedOn.push("state");
  }
  if (zip && zip5(address?.zip) === zip) {
    score += SCORE.ZIP;
    matchedOn.push("zip");
  }
  if (street) {
    // The SEC splits the line across street1/street2 inconsistently: 2907 files
    // "110 REGENT COURT, SUITE 202" entirely in street1, while the BD-side record splits it.
    // Comparing building-only bases sidesteps the split completely.
    const filed = streetBase([address?.street1, address?.street2].filter(Boolean).join(" "));
    if (filed && filed === street) {
      score += SCORE.ADDRESS;
      matchedOn.push("address");
    }
  }

  return { score, matchedOn, nameMatched: name.matched };
}

/** A CRD is only ever returned when the evidence includes the NAME. Address agreement alone
 *  means "same building", and office buildings are full of unrelated advisory firms. */
function confidenceFor(score, nameMatched) {
  if (!nameMatched || score < MIN_SCORE) return "low";
  return score >= HIGH_SCORE ? "high" : "medium";
}


// ---------------------------------------------------------------------------
// step 1 — phone -> live business identity (Google Places)
// ---------------------------------------------------------------------------

/**
 * Look a phone number up as a business on Google Places.
 *
 * NEVER THROWS. Every failure — no key, bad key, network fault, unparseable number, no such
 * listing — comes back as `{found:false, reason}` so the caller can degrade to the offline
 * path instead of 500ing.
 *
 * A miss is `{}` — an empty JSON OBJECT, not an error and not `{"places":[]}`. Verified live:
 * "+1 805-482-8899" and "+1 914-225-1000" both return exactly `{}`.
 *
 * @returns {Promise<{found:true, placeId, name, formattedAddress, phone, website,
 *                    street, city, state, zip, phoneVerified:boolean}
 *                 | {found:false, reason:string}>}
 */
export async function lookupBusinessByPhone(phone, deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    apiKey = process.env.PLACES_API_KEY,
    url = PLACES_SEARCH_TEXT_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now(),
    memoTtlMs = PLACES_MEMO_TTL_MS,
  } = deps;

  const parsed = normalizePhone(phone);
  if (!parsed.ok) {
    return { found: false, reason: PLACES_REASON.INVALID_PHONE, detail: parsed.reason };
  }

  const key = String(apiKey ?? "").trim();
  // Graceful degradation, not an exception: an operator who has not wired the key yet should
  // see the offline path keep working, not a broken endpoint.
  if (!key) return { found: false, reason: PLACES_REASON.UNCONFIGURED };
  if (typeof fetchImpl !== "function") {
    return { found: false, reason: PLACES_REASON.UNCONFIGURED, detail: "no fetch implementation" };
  }

  const memoKey = parsed.e164;
  const memoed = memoGet(memoKey, now);
  if (memoed !== undefined) return memoed;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: parsed.e164, regionCode: "US" }),
      signal: controller.signal,
    });

    if (response && response.ok === false) {
      // A bad key is HTTP 400 here. Do not memo a failure — the operator may fix the key.
      return { found: false, reason: PLACES_REASON.ERROR, status: Number(response.status ?? 0) };
    }
    body = await response.json();
  } catch (error) {
    return { found: false, reason: PLACES_REASON.ERROR, detail: error?.message || "request failed" };
  } finally {
    clearTimeout(timer);
  }

  const places = Array.isArray(body?.places) ? body.places : [];
  if (places.length === 0) {
    return memoSet(memoKey, { found: false, reason: PLACES_REASON.NO_MATCH }, now, memoTtlMs);
  }

  const place = places[0];
  const listed = normalizePhone(place?.nationalPhoneNumber);

  // searchText is a TEXT search that happens to be very good at phone numbers — it is not a
  // guaranteed reverse-phone endpoint. If it hands back a business whose own listed number is
  // a different one, it matched on something else and this is not our business.
  if (listed.ok && listed.national10 !== parsed.national10) {
    return memoSet(memoKey, { found: false, reason: PLACES_REASON.PHONE_MISMATCH }, now, memoTtlMs);
  }

  const formattedAddress = place?.formattedAddress ?? null;
  const parts = parseFormattedAddress(formattedAddress);

  const result = {
    found: true,
    placeId: place?.id ?? null,
    name: place?.displayName?.text ?? null,
    formattedAddress,
    phone: place?.nationalPhoneNumber ?? null,
    website: place?.websiteUri ?? null,
    street: parts.street,
    city: parts.city,
    state: parts.state,
    zip: parts.zip,
    // False when Places returned no phone at all. The resolver caps confidence in that case:
    // we asked by phone and did not get the number echoed back, so the link is unproven.
    phoneVerified: listed.ok && listed.national10 === parsed.national10,
  };

  return memoSet(memoKey, result, now, memoTtlMs);
}

// ---------------------------------------------------------------------------
// step 2 — business identity -> firm CRD (SEC IAPD)
// ---------------------------------------------------------------------------

/**
 * IAPD firm-search queries to try, most specific to least.
 *
 * The full business name is NOT reliable on its own (see the module header: it returned one
 * wrong firm for Nestlerode). Shortened forms are, so they go first, and results are pooled
 * regardless of which query produced them.
 */
export function firmQueryVariants(businessName) {
  const raw = String(businessName ?? "").trim();
  if (!raw) return [];

  const variants = [];
  const push = (value) => {
    const v = String(value ?? "").trim();
    if (!v) return;
    if (variants.some((existing) => existing.toLowerCase() === v.toLowerCase())) return;
    variants.push(v);
  };

  const normalized = normalizeFirmName(raw);
  const tokens = tokensOf(normalized);

  // "Yanni & Associates Investment Advisors, LLC" -> "yanni"; "Nestlerode & Loy ..." ->
  // "nestlerode loy". The identifying words with everything else stripped away.
  push(distinctiveTokens(normalized).join(" "));

  // Everything up to the first industry word, which keeps a firm whose real name contains a
  // generic token ("Main Street Wealth") from being cut down to nothing useful.
  const firstGeneric = tokens.findIndex((t) => GENERIC_TOKENS.has(t));
  if (firstGeneric > 0) push(tokens.slice(0, firstGeneric).join(" "));

  // The legal-suffix-free full name, then the untouched name as Places spelled it.
  push(normalized);
  push(raw);

  return variants.slice(0, MAX_QUERY_VARIANTS);
}

/** Bounded-parallel map. Politeness toward the SEC, and the pool is small anyway. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Resolve a live Places business to an SEC firm CRD.
 *
 * Never throws on an upstream fault: an IAPD outage returns `{crd:null, ... reason:
 * "iapd_error"}`, which the caller can present as "we could not check right now" rather than
 * as "no such firm".
 *
 * @returns {Promise<{crd:number|null, firmName:string|null,
 *                    confidence:"high"|"medium"|"low", matchedOn:string[],
 *                    candidates:Array<{crd,name,score}>}>}
 */
export async function resolveFirmFromBusiness(business, deps = {}) {
  const {
    searchFirms = searchFirmsByName,
    firmDetail = getFirm,
    iapd = {},
    detailChecks = DEFAULT_DETAIL_CHECKS,
    searchLimit = DEFAULT_SEARCH_LIMIT,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    concurrency = 3,
  } = deps;

  const miss = (reason) => ({
    crd: null,
    firmName: null,
    confidence: "low",
    matchedOn: [],
    candidates: [],
    reason,
  });

  if (!business?.found) return miss(business?.reason ?? PLACES_REASON.NO_BUSINESS);

  const variants = firmQueryVariants(business.name);
  if (variants.length === 0) return miss(PLACES_REASON.NO_BUSINESS);

  // --- pool candidates across every variant ------------------------------------------
  const pool = new Map(); // crd -> { crd, name, address, queries[] }
  let searchFailures = 0;

  // ToS: `query` is built from the Google displayName, and iapd.mjs puts the query INTO its
  // cache key — so the caller's cache (the persisted, snapshotted firm cache in production) is
  // overridden here with the memory-only one. Firm DETAIL below keeps the caller's cache: it
  // is keyed by CRD and holds SEC public record, which is exactly what belongs on disk.
  const searchTransport = { ...iapd, cache: firmSearchCache };

  for (const query of variants) {
    let result;
    try {
      result = await searchFirms(query, { limit: searchLimit, ...searchTransport });
    } catch {
      // One bad variant must not sink the lookup — another may still find the firm.
      searchFailures++;
      continue;
    }
    for (const firm of result?.firms ?? []) {
      if (firm?.crd == null) continue;
      const existing = pool.get(firm.crd);
      if (existing) {
        existing.queries.push(query);
        continue;
      }
      pool.set(firm.crd, {
        crd: firm.crd,
        name: firm.name,
        address: firm.officeAddress ?? null,
        // Carried through to the caller as the FIRM-SIZE signal. Morgan Stanley-class firms
        // report hundreds of branches; a two-person RIA reports 1. A caller deciding whether
        // to show "is this you?" needs this to avoid framing a wirehouse as a small shop.
        branchCount: firm.branchCount ?? null,
        queries: [query],
      });
    }
  }

  if (pool.size === 0) {
    // Distinguish "IAPD is down" from "IAPD says no such firm". Same empty result, very
    // different thing to tell a user.
    return miss(searchFailures === variants.length ? PLACES_REASON.IAPD_ERROR : PLACES_REASON.NO_CANDIDATES);
  }

  // --- pre-rank on the address the search endpoint already embedded (free) -------------
  const preRanked = [...pool.values()]
    .map((candidate) => {
      const scored = scoreCandidate(business, candidate.name, candidate.address);
      return { ...candidate, ...scored, confirmed: false };
    })
    .sort((a, b) => b.score - a.score);

  // --- confirm the top few against the authoritative firm detail ----------------------
  // Only candidates with a name signal are worth a round trip; the rest cannot clear
  // MIN_SCORE no matter what their address says.
  const toConfirm = preRanked.filter((c) => c.nameMatched).slice(0, detailChecks);

  await mapWithConcurrency(toConfirm, concurrency, async (candidate) => {
    try {
      const detail = await firmDetail(candidate.crd, iapd);
      const scored = scoreCandidate(business, detail?.name ?? candidate.name, detail?.officeAddress);
      // Detail is authoritative; the search-embedded address was only a ranking hint.
      candidate.score = scored.score;
      candidate.matchedOn = scored.matchedOn;
      candidate.nameMatched = scored.nameMatched;
      candidate.name = detail?.name ?? candidate.name;
      candidate.confirmed = true;
    } catch {
      // Leave the pre-ranked score. It is real evidence, just not confirmed — and the
      // `confirmed:false` flag below is what stops it from being read as more than that.
    }
  });

  const ranked = preRanked.slice().sort((a, b) => b.score - a.score);
  const candidates = ranked.slice(0, Math.max(1, maxCandidates)).map((c) => ({
    crd: c.crd,
    name: c.name,
    score: c.score,
    matchedOn: c.matchedOn,
    confirmed: c.confirmed,
    branchCount: c.branchCount ?? null,
  }));

  const top = ranked[0];
  const runnerUp = ranked[1];

  let confidence = confidenceFor(top.score, top.nameMatched);

  // An unconfirmed top candidate has only the search payload behind it. Real evidence, but
  // not the authoritative record, so it cannot be our top confidence tier.
  if (confidence === "high" && !top.confirmed) confidence = "medium";

  // Places gave us no phone to echo back, so "this number belongs to this business" is
  // assumed rather than shown.
  if (business.phoneVerified === false && confidence === "high") confidence = "medium";

  // Two credible firms our evidence cannot separate — the classic case is one firm that
  // re-registered under a new CRD and still files the old name and address. Picking the
  // higher score here is a coin flip dressed as an answer, so we refuse outright rather than
  // merely lowering confidence: this is precisely the situation the candidate list and a
  // human "which one?" prompt exist for.
  //
  // Only a runner-up that would ITSELF have qualified counts. Scores are coarse enough
  // (name 50 is the only sub-100 component) that genuinely different firms land far more
  // than AMBIGUITY_MARGIN apart — measured live, the Nestlerode runner-up trails by 165 and
  // the Yanni runner-up by 145 — so this does not fire on real traffic.
  const ambiguous =
    runnerUp != null && runnerUp.score >= MIN_SCORE && top.score - runnerUp.score < AMBIGUITY_MARGIN;
  if (ambiguous) confidence = "low";

  if (confidence === "low") {
    return {
      crd: null,
      firmName: null,
      confidence: "low",
      matchedOn: [],
      candidates,
      reason: ambiguous ? "ambiguous" : PLACES_REASON.BELOW_THRESHOLD,
      topScore: top.score,
      minScore: MIN_SCORE,
    };
  }

  return {
    crd: top.crd,
    firmName: top.name,
    confidence,
    matchedOn: top.matchedOn,
    candidates,
    score: top.score,
    maxScore: MAX_SCORE,
    branchCount: top.branchCount ?? null,
    ambiguous,
  };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * phone -> Google Places -> SEC IAPD -> firm CRD. Fully live; touches no snapshot.
 *
 * ToS: within `business`, ONLY `placeId` may be persisted — restated in the payload as
 * `business.persistable` so a downstream writer cannot claim it did not know.
 *
 * Note on big firms: resolving a phone to a CRD says NOTHING about how many people work
 * there. A wirehouse switchboard and a two-person RIA both resolve to exactly one CRD, and
 * presenting the second shape for the first is how a caller ends up being offered a
 * "claim your profile" pick-list against a 20,000-adviser firm. `branchCount` (from the SEC's
 * own filing — Morgan Stanley-class firms report hundreds, a small RIA reports 1) is surfaced
 * as the cheap size signal, but the authoritative gate stays where it already is: the live
 * roster count against config.lookup.fewCandidatesMax. A CRD from here is an INPUT to that
 * decision, never a substitute for it.
 */
export async function resolveByPhoneLive(phone, deps = {}) {
  const parsed = normalizePhone(phone);
  const phoneBlock = {
    input: phone == null ? null : String(phone),
    national10: parsed.national10,
    e164: parsed.e164,
    valid: parsed.ok,
  };

  const business = await lookupBusinessByPhone(phone, deps);

  // Same key set on every path: a consumer destructuring `maxScore` or `branchCount` must not
  // get a number on a hit and `undefined` on a miss.
  if (!business.found) {
    return {
      found: false,
      phone: phoneBlock,
      business: null,
      crd: null,
      firmName: null,
      confidence: "low",
      matchedOn: [],
      candidates: [],
      score: null,
      maxScore: MAX_SCORE,
      branchCount: null,
      reason: business.reason,
    };
  }

  const firm = await resolveFirmFromBusiness(business, deps);

  return {
    found: firm.crd != null,
    phone: phoneBlock,
    business: {
      ...business,
      // Load-bearing ToS marker. Everything else in this object is live-use only.
      persistable: ["placeId"],
    },
    crd: firm.crd,
    firmName: firm.firmName,
    confidence: firm.confidence,
    matchedOn: firm.matchedOn,
    candidates: firm.candidates,
    score: firm.score ?? firm.topScore ?? null,
    maxScore: MAX_SCORE,
    // SEC-filed branch count for the matched firm — the size signal. See the note above.
    branchCount: firm.branchCount ?? null,
    reason: firm.reason ?? null,
  };
}
