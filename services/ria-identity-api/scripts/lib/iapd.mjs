// SEC Investment Adviser Public Disclosure (IAPD) client.
//
// Talks to the same public, unauthenticated JSON API that adviserinfo.sec.gov serves to
// any browser. No key, no session, no cookie. We identify ourselves by User-Agent so the
// SEC can find us if our traffic is ever a problem.
//
// Contract verified live 2026-08-06. Five behaviours of this API are surprising enough
// that they are encoded here rather than left to callers:
//
//  1. ERRORS ARRIVE AS HTTP 200. Asking for nrows=200 returns status 200 with a body of
//     {"errorCode":-1,"errorMessage":"Exceeded limit","hits":null}. Checking the status
//     code alone silently yields "no advisers at this firm". assertEnvelope() is the guard.
//
//  2. `firm=` MATCHES MORE THAN THE CURRENT ROSTER. It also hits previous employers and
//     (verified) the firm's SEC number, so people who left — or who never worked there —
//     come back in the result set. Filtering on
//     _source.ind_ia_current_employments[].firm_id === <the CRD we asked for>
//     is LOAD-BEARING: without it we would offer a departed adviser the chance to claim a
//     profile at their old firm. Live proof, firm=110518: total 1, currentCount 0 — the
//     single hit's current employer is CRD 135037.
//
//  3. THE CRDs ARE STRINGS IN ONE ENDPOINT AND NUMBERS IN ANOTHER. The roster returns
//     firm_id:"142913" (string); the individual detail returns firmId:142913 (number).
//     A literal `===` between the two forms is ALWAYS false, which would silently make
//     every roster look empty and turn trap #2 into a permanent outage. sameCrd() compares
//     numerically and is the only comparison used here.
//
//  4. DETAIL PAYLOADS ARE DOUBLE-ENCODED. The real object is a JSON *string* at
//     hits.hits[0]._source.iacontent and needs a second JSON.parse.
//
//  5. AN UNKNOWN CRD IS NOT A 404. It is HTTP 200 with {"hits":{"total":0,"hits":[]}},
//     which we surface as a typed IapdNotFoundError instead of a null-shaped object.
//
// Everything returned here is already public on adviserinfo.sec.gov. This module never
// infers, enriches or invents a personal contact detail — see the service README on
// minimal disclosure before verification.

/** Fallback identity, used only when the caller passes no `userAgent`. The configured value
 *  in config.mjs is threaded through the transport on every call — this constant exists so
 *  the module still identifies itself honestly when used directly (scripts, tests). */
export const DEFAULT_USER_AGENT = "hushh-ria-identity-api/0.1 (+https://hushh.ai; contact ankit@hushh.ai)";

export const IAPD_API_BASE = "https://api.adviserinfo.sec.gov/search";
export const IAPD_PUBLIC_BASE = "https://adviserinfo.sec.gov";

/** nrows is hard-capped by the API: 100 works, 200 returns "Exceeded limit". */
export const MAX_NROWS = 100;
/** Deep paging dies somewhere past ~9000; refuse before the API does. */
export const MAX_RESULT_WINDOW = 9000;

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 200;

export class IapdError extends Error {
  constructor(message, { status = null, code = null, retriable = false, context = null } = {}) {
    super(message);
    this.name = "IapdError";
    this.status = status;
    this.code = code;
    this.retriable = retriable;
    this.context = context;
  }
}

/** The CRD is well-formed but SEC has no such record. Distinct from IapdError so callers
 *  can degrade to "we could not find that adviser" instead of "IAPD is down". */
export class IapdNotFoundError extends IapdError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "IapdNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// value coercion
// ---------------------------------------------------------------------------

/** CRDs arrive as "142913" or 142913 depending on the endpoint. One numeric form. */
export function toCrd(value) {
  if (value == null) return null;
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The comparison trap #3 exists to defeat. Never compare CRDs with `===` directly. */
export function sameCrd(a, b) {
  const x = toCrd(a);
  const y = toCrd(b);
  return x != null && y != null && x === y;
}

/** IAPD encodes booleans as "Y"/"N". Absent means unknown, which is not the same as false. */
function yn(value) {
  if (value == null) return null;
  const v = String(value).trim().toUpperCase();
  if (v === "Y") return true;
  if (v === "N") return false;
  return null;
}

function str(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/** Latitude/longitude arrive as strings ("40.627036"). Keep them numeric or null. */
function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function joinName(...parts) {
  return parts
    .map((p) => str(p))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

export const individualReportUrl = (crd) => `${IAPD_PUBLIC_BASE}/individual/summary/${crd}`;
export const firmReportUrl = (crd) => `${IAPD_PUBLIC_BASE}/firm/summary/${crd}`;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

/** Trap #1: a failure can be dressed as HTTP 200. A body is only usable when errorCode is
 *  clear AND the hits envelope exists. */
function assertEnvelope(body, context) {
  if (!body || typeof body !== "object") {
    throw new IapdError(`IAPD returned a non-object body (${context})`, { context });
  }
  if (body.errorCode != null && body.errorCode !== 0) {
    throw new IapdError(`IAPD rejected the request (${context}): ${body.errorMessage || body.errorCode}`, {
      code: body.errorCode,
      context,
    });
  }
  if (body.hits == null) {
    throw new IapdError(`IAPD returned no hits envelope (${context}): ${body.errorMessage || "hits was null"}`, {
      context,
    });
  }
  return body;
}

/** Elasticsearch reports total as a bare number here, but newer ES versions use
 *  {value, relation}. Accept both so a server-side upgrade cannot zero out our counts. */
function totalOf(hits) {
  const t = hits?.total;
  if (typeof t === "number") return t;
  if (t && typeof t === "object" && Number.isFinite(Number(t.value))) return Number(t.value);
  return arr(hits?.hits).length;
}

/** Process-wide pacing gate for outbound SEC calls.
 *
 *  `gapMs` used to be a config value nothing read. It is a politeness control — the minimum
 *  spacing between two requests to api.adviserinfo.sec.gov from this process — so it has to
 *  serialise across concurrent callers, not per-call. Chaining onto a single promise is what
 *  makes six parallel profile fetches queue behind each other instead of all seeing the same
 *  "last request was ages ago" and firing at once.
 *
 *  Default 0 keeps the fast path free of any await. */
let gapChain = Promise.resolve();
let lastRequestAt = 0;
function paced(gapMs) {
  const gap = Number(gapMs) || 0;
  if (gap <= 0) return Promise.resolve();
  const wait = gapChain.then(async () => {
    const due = lastRequestAt + gap;
    const delay = due - Date.now();
    if (delay > 0) await sleep(delay);
    lastRequestAt = Date.now();
  });
  // Never let one rejection poison the chain for every later request.
  gapChain = wait.catch(() => {});
  return wait;
}

/** One request, at most three attempts. Retries only on a network fault or 5xx — a 4xx
 *  will not improve by asking again, so it throws immediately and typed. */
async function requestJson(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    // Threaded from config.iapd.userAgent. The SEC-facing identity of this service is a
    // configurable, contactable string — not a constant only a code change can move.
    userAgent = DEFAULT_USER_AGENT,
    gapMs = 0,
    context = "iapd",
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new IapdError(`No fetch implementation available (${context})`, { context });
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    await paced(gapMs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          "user-agent": String(userAgent || "").trim() || DEFAULT_USER_AGENT,
        },
        signal: controller.signal,
      });

      const status = Number(response?.status ?? 0);
      if (status === 429 || status >= 500) {
        lastError = new IapdError(`IAPD HTTP ${status} (${context})`, {
          status,
          retriable: true,
          context,
        });
        continue;
      }
      if (response && response.ok === false) {
        throw new IapdError(`IAPD HTTP ${status} (${context})`, { status, context });
      }
      return await response.json();
    } catch (error) {
      // A non-retriable typed error is final; anything else (DNS, socket, abort) is worth
      // one more try.
      if (error instanceof IapdError && !error.retriable) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof IapdError) throw lastError;
  throw new IapdError(`IAPD request failed (${context}): ${lastError?.message || "unknown error"}`, {
    retriable: true,
    context,
  });
}

/** Trap #4: the payload we want is a JSON string inside the JSON we just parsed. */
export function parseDoubleEncoded(body, { context, crd }) {
  assertEnvelope(body, context);
  const hit = arr(body.hits.hits)[0];
  if (!hit) {
    // Trap #5: unknown CRD is a 200 with an empty hit list.
    throw new IapdNotFoundError(`IAPD has no record for CRD ${crd} (${context})`, { status: 404, context });
  }
  const raw = hit._source?.iacontent;
  if (raw == null) {
    throw new IapdError(`IAPD hit for CRD ${crd} carried no iacontent (${context})`, { context });
  }
  if (typeof raw === "object") return raw; // already decoded — tolerate a future fix
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new IapdError(`IAPD iacontent for CRD ${crd} was not valid JSON (${context}): ${error.message}`, {
      context,
    });
  }
}

/** Read-through the injected cache when there is one; otherwise just produce.
 *
 *  IMPORTANT: callers must validate and map INSIDE `produce`, so only good data is ever
 *  stored. Caching the raw body instead would let one "Exceeded limit" reply (trap #1 —
 *  which arrives as a perfectly cacheable HTTP 200) poison the key for the whole TTL. A
 *  rejected producer is never cached. */
function withCache(cache, key, produce) {
  return typeof cache?.wrap === "function" ? cache.wrap(key, produce) : produce();
}

function requireCrd(value, label) {
  const crd = toCrd(value);
  if (crd == null) {
    throw new IapdError(`${label} must be a positive integer CRD, got ${JSON.stringify(value)}`, {
      status: 400,
    });
  }
  return crd;
}

// ---------------------------------------------------------------------------
// mappers
// ---------------------------------------------------------------------------

/** Pick the employment row that proves this person is at `firmCrd` right now. A person can
 *  hold several rows for one firm (one per branch — State Farm advisers routinely do), so
 *  we take the first match and treat the rest as duplicates. */
function currentEmploymentAt(source, firmCrd) {
  const employments = arr(source?.ind_ia_current_employments);
  if (firmCrd == null) return employments[0] || null;
  return employments.find((e) => sameCrd(e?.firm_id, firmCrd)) || null;
}

/** Roster/search hit -> Individual. `firmCrd` is the firm we asked about; pass null for a
 *  name search, where "current at firm" has no meaning and is reported false. */
function mapSearchIndividual(source, firmCrd) {
  const match = currentEmploymentAt(source, firmCrd);
  const isCurrentAtFirm = firmCrd != null && match != null;
  // Show the branch tied to the firm in question; for a name search fall back to whatever
  // current employment the API listed first.
  const branch = match || arr(source?.ind_ia_current_employments)[0] || null;

  return {
    crd: toCrd(source?.ind_source_id),
    firstName: str(source?.ind_firstname),
    middleName: str(source?.ind_middlename),
    lastName: str(source?.ind_lastname),
    name: joinName(source?.ind_firstname, source?.ind_middlename, source?.ind_lastname, source?.ind_namesuffix),
    iaScope: str(source?.ind_ia_scope),
    isCurrentAtFirm,
    hasDisclosures: yn(source?.ind_ia_disclosure_fl) === true,
    iaOnly: yn(branch?.ia_only),
    branchCity: str(branch?.branch_city),
    branchState: str(branch?.branch_state),
    branchZip: str(branch?.branch_zip),
  };
}

function mapBranch(location) {
  return {
    branchOfficeId: str(location?.branchOfficeId),
    street1: str(location?.street1),
    street2: str(location?.street2),
    city: str(location?.city),
    state: str(location?.state),
    zip: str(location?.zipCode),
    lat: num(location?.latitude),
    lng: num(location?.longitude),
    privateResidence: yn(location?.privateResidenceFlag),
  };
}

function mapCurrentEmployment(employment) {
  return {
    firmCrd: toCrd(employment?.firmId),
    firmName: str(employment?.firmName),
    iaOnly: yn(employment?.iaOnly),
    registrationBeginDate: str(employment?.registrationBeginDate),
    branches: arr(employment?.branchOfficeLocations).map(mapBranch),
  };
}

function mapPreviousEmployment(employment) {
  return {
    firmCrd: toCrd(employment?.firmId),
    firmName: str(employment?.firmName),
    from: str(employment?.registrationBeginDate),
    to: str(employment?.registrationEndDate),
  };
}

/** IAPD splits exams across three parallel arrays that share a shape. */
function mapExams(content) {
  return [
    ...arr(content?.stateExamCategory),
    ...arr(content?.principalExamCategory),
    ...arr(content?.productExamCategory),
  ].map((exam) => ({
    code: str(exam?.examCategory),
    name: str(exam?.examName),
    date: str(exam?.examTakenDate),
  }));
}

/** IA rows first (this is an adviser service), then any broker-dealer row the IA side did
 *  not already cover. Dual registrants otherwise lose half their history. */
function mergeEmployments(iaRows, bcRows, mapFn, keyFn) {
  const out = [];
  const seen = new Set();
  for (const row of [...arr(iaRows), ...arr(bcRows)]) {
    const mapped = mapFn(row);
    const key = keyFn(mapped);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
  }
  return out;
}

function mapAddress(address) {
  if (!address || typeof address !== "object") return null;
  return {
    street1: str(address.street1),
    street2: str(address.street2),
    city: str(address.city),
    state: str(address.state),
    zip: str(address.postalCode ?? address.zipCode),
    country: str(address.country),
  };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * The advisers the SEC associates with a firm.
 *
 * Returns the raw match set with each person flagged, plus `currentCount` — the number who
 * are actually at this firm today. CALLERS MUST RANK ON isCurrentAtFirm / currentCount, not
 * on individuals.length, or trap #2 will hand someone their old employer's roster. Current
 * people are sorted first, and `opts.currentOnly` drops the rest entirely.
 */
export async function listFirmIndividuals(firmCrd, opts = {}) {
  const crd = requireCrd(firmCrd, "firmCrd");
  const {
    limit = MAX_NROWS,
    start = 0,
    currentOnly = false,
    base = IAPD_API_BASE,
    cache,
    ...transport
  } = opts;

  const nrows = Math.max(1, Math.min(MAX_NROWS, Number(limit) || MAX_NROWS));
  const offset = Math.max(0, Number(start) || 0);
  if (offset + nrows > MAX_RESULT_WINDOW) {
    throw new IapdError(
      `IAPD cannot page beyond ${MAX_RESULT_WINDOW} results (start=${offset}, nrows=${nrows})`,
      { status: 400 },
    );
  }

  const context = `firm roster ${crd}`;
  // NOTE: `firm` is the only parameter that filters. firm_crd / firmid / firm_id are
  // accepted and SILENTLY IGNORED, returning an unfiltered corpus-wide total.
  const url = `${base}/individual?firm=${crd}&nrows=${nrows}&start=${offset}&wt=json`;

  // The unfiltered roster is what gets cached; `currentOnly` is a view applied afterwards,
  // so both callers share one entry.
  const roster = await withCache(cache, `iapd:roster:${crd}:${offset}:${nrows}`, async () => {
    const body = await requestJson(url, { ...transport, context });
    assertEnvelope(body, context);

    const individuals = arr(body.hits.hits)
      .map((hit) => mapSearchIndividual(hit?._source, crd))
      .sort((a, b) => Number(b.isCurrentAtFirm) - Number(a.isCurrentAtFirm));

    return {
      total: totalOf(body.hits),
      currentCount: individuals.filter((i) => i.isCurrentAtFirm).length,
      individuals,
    };
  });

  return {
    total: roster.total,
    currentCount: roster.currentCount,
    individuals: currentOnly ? roster.individuals.filter((i) => i.isCurrentAtFirm) : roster.individuals,
  };
}

/** Full public profile for one adviser. */
export async function getIndividual(individualCrd, opts = {}) {
  const crd = requireCrd(individualCrd, "individualCrd");
  const { base = IAPD_API_BASE, cache, ...transport } = opts;
  const context = `individual ${crd}`;

  return withCache(cache, `iapd:individual:${crd}`, async () => {
    const body = await requestJson(`${base}/individual/${crd}?wt=json`, { ...transport, context });
    const content = parseDoubleEncoded(body, { context, crd });
    const basic = content?.basicInformation || {};

    const hasDisclosures = yn(content?.iaDisclosureFlag) === true || yn(content?.disclosureFlag) === true;

    return {
      crd: toCrd(basic.individualId) ?? crd,
      name: joinName(basic.firstName, basic.middleName, basic.lastName, basic.nameSuffix),
      firstName: str(basic.firstName),
      middleName: str(basic.middleName),
      lastName: str(basic.lastName),
      otherNames: arr(basic.otherNames).map((n) => joinName(n)).filter(Boolean),
      currentEmployments: mergeEmployments(
        content?.currentIAEmployments,
        content?.currentEmployments,
        mapCurrentEmployment,
        (e) => `${e.firmCrd}`,
      ),
      previousEmployments: mergeEmployments(
        content?.previousIAEmployments,
        content?.previousEmployments,
        mapPreviousEmployment,
        (e) => `${e.firmCrd}|${e.from}|${e.to}`,
      ),
      exams: mapExams(content),
      examCounts: content?.examsCount || null,
      registeredStates: arr(content?.registeredStates),
      registeredSROs: arr(content?.registeredSROs),
      registrationCount: content?.registrationCount || null,
      hasDisclosures,
      disclosures: [...arr(content?.iaDisclosures), ...arr(content?.disclosures)],
      reportUrl: individualReportUrl(crd),
    };
  });
}

/** Firm-level public record. Note this endpoint does NOT list the firm's people — that is
 *  what listFirmIndividuals is for. */
export async function getFirm(firmCrd, opts = {}) {
  const crd = requireCrd(firmCrd, "firmCrd");
  const { base = IAPD_API_BASE, cache, ...transport } = opts;
  const context = `firm ${crd}`;

  return withCache(cache, `iapd:firm:${crd}`, async () => {
    const body = await requestJson(`${base}/firm/${crd}?wt=json`, { ...transport, context });
    const content = parseDoubleEncoded(body, { context, crd });
    const basic = content?.basicInformation || {};
    const addresses = content?.iaFirmAddressDetails || {};

    // "801" + "123404" is displayed by the SEC as 801-123404.
    const secNumber =
      str(basic.iaSECNumber) && str(basic.iaSECNumberType)
        ? `${str(basic.iaSECNumberType)}-${str(basic.iaSECNumber)}`
        : str(basic.iaSECNumber);

    return {
      crd: toCrd(basic.firmId) ?? crd,
      name: str(basic.firmName),
      secNumber,
      iaScope: str(basic.iaScope),
      isIaFirm: yn(basic.isIAFirm) === true,
      officeAddress: mapAddress(addresses.officeAddress),
      mailingAddress: mapAddress(addresses.mailingAddress),
      registrationStatus: arr(content?.registrationStatus),
      noticeFilings: arr(content?.noticeFilings),
      // `brochures` is an OBJECT wrapping a lowercase `brochuredetails` array, not an array.
      brochures: arr(content?.brochures?.brochuredetails).map((b) => ({
        versionId: toCrd(b?.brochureVersionID) ?? null,
        name: str(b?.brochureName),
        dateSubmitted: str(b?.dateSubmitted),
      })),
      reportUrl: firmReportUrl(crd),
    };
  });
}

/** The firm-search hit carries its address as a JSON *string* (trap #4 again, in a second
 *  place). A malformed one must NOT kill an otherwise good search: a candidate with no
 *  address simply loses every geographic signal and ranks itself out. Fails soft, on
 *  purpose. */
function parseEmbeddedJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Firm-search hit -> Firm summary. Prefers the IA address over the broker-dealer one:
 *  this is an adviser service, and a dual registrant can file different addresses on each
 *  side. */
function mapSearchFirm(source) {
  const ia = parseEmbeddedJson(source?.firm_ia_address_details);
  const bd = parseEmbeddedJson(source?.firm_address_details);

  return {
    crd: toCrd(source?.firm_source_id),
    name: str(source?.ia_firm_name) || str(source?.firm_name),
    // The DBA list is why a firm-name search can return a wildly unrelated firm as its ONLY
    // hit — see the searchFirmsByName header. Callers need it to explain a match.
    otherNames: arr(source?.firm_other_names).map((n) => str(n)).filter(Boolean),
    secNumber: str(source?.firm_ia_full_sec_number) || str(source?.firm_bd_full_sec_number),
    iaScope: str(source?.firm_ia_scope),
    officeAddress: mapAddress(ia?.officeAddress) || mapAddress(bd?.officeAddress),
    branchCount: num(source?.firm_branches_count),
  };
}

/**
 * Search FIRMS by name.
 *
 * Unlike the individual endpoint, `query` here matches firm names — and also every DBA in
 * `firm_other_names`, which is the trap that makes this endpoint dangerous to trust alone:
 *
 *   query "Nestlerode & Loy Investment Advisors" -> total 1, and that ONE hit is
 *   CRD 144426 INTERNATIONAL ASSETS INVESTMENT MANAGEMENT, LLC (Orlando, FL), which matched
 *   on one of its 100 registered DBAs. The firm actually wanted, CRD 2907 NESTLERODE & LOY,
 *   INC. (State College, PA), is not in the result set at all. Dropping two words —
 *   query "Nestlerode & Loy" — returns 2907 and nothing else.
 *
 * So `total: 1` is NOT a confidence signal here, and a single hit MUST be cross-validated
 * against something outside IAPD (an address, a phone) before it is treated as the answer.
 * That validation lives in places.mjs; this function only reports what the SEC returned.
 *
 * `officeAddress` is included on every hit precisely so the caller can do that
 * cross-validation without a detail fetch per candidate.
 *
 * A PERSISTED CACHE IS REFUSED HERE. The cache key for this call contains the SEARCH STRING,
 * and on the live chain that string is built out of a Google Places `displayName` — which the
 * Maps Platform terms allow us to use in the response we are serving and nowhere else. A
 * persisted cache turned that into `iapd:firmsearch:nestlerode & loy investment advisors:10`
 * sitting in the on-disk snapshot for 30 days. places.mjs already passes its own memory-only
 * cache; this is the backstop for the next caller, who will not have read that file.
 */
export async function searchFirmsByName(name, opts = {}) {
  const query = str(name);
  if (!query) {
    throw new IapdError("searchFirmsByName requires a non-empty name", { status: 400 });
  }
  const { limit = 10, base = IAPD_API_BASE, cache: requestedCache, ...transport } = opts;
  // Degrade to uncached rather than throw: a wrong cache must cost an extra round trip to the
  // SEC, never the caller's answer.
  const cache = requestedCache?.persisted === true ? null : requestedCache;
  // Shares trap #1: nrows=200 returns HTTP 200 with {"errorCode":-1,"errorMessage":
  // "Exceeded limit"} — verified live on this endpoint, not just the individual one.
  const nrows = Math.max(1, Math.min(MAX_NROWS, Number(limit) || 10));

  const params = new URLSearchParams({ query, nrows: String(nrows), wt: "json" });
  const context = `firm name search ${query}`;

  return withCache(cache, `iapd:firmsearch:${query.toLowerCase()}:${nrows}`, async () => {
    const body = await requestJson(`${base}/firm?${params.toString()}`, { ...transport, context });
    assertEnvelope(body, context);

    return {
      total: totalOf(body.hits),
      firms: arr(body.hits.hits)
        .map((hit) => mapSearchFirm(hit?._source))
        .filter((firm) => firm.crd != null),
    };
  });
}

/**
 * Name fallback for when the office phone misses.
 *
 * `query` matches PERSON names only — a firm name returns zero hits — and there are no
 * wildcards. `state` is a real filter and repeats as OR; `city` is accepted and always
 * returns zero, so it is deliberately not offered here.
 */
export async function searchIndividualsByName(name, opts = {}) {
  const query = str(name);
  if (!query) {
    throw new IapdError("searchIndividualsByName requires a non-empty name", { status: 400 });
  }
  const { state = null, limit = 25, base = IAPD_API_BASE, cache, ...transport } = opts;
  const nrows = Math.max(1, Math.min(MAX_NROWS, Number(limit) || 25));

  const params = new URLSearchParams({ query, nrows: String(nrows), wt: "json" });
  const states = (Array.isArray(state) ? state : [state])
    .map((s) => str(s))
    .filter(Boolean)
    .map((s) => s.toUpperCase());
  for (const s of states) params.append("state", s);

  const context = `name search ${query}`;
  return withCache(cache, `iapd:search:${query.toLowerCase()}:${states.join(",")}:${nrows}`, async () => {
    const body = await requestJson(`${base}/individual?${params.toString()}`, { ...transport, context });
    assertEnvelope(body, context);

    // firmCrd is null: "current at firm" is meaningless without a firm in the question.
    return arr(body.hits.hits).map((hit) => mapSearchIndividual(hit?._source, null));
  });
}
