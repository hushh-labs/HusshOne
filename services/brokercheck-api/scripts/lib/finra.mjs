// FINRA BrokerCheck public API client.
//
// Contract verified live 2026-08-04. Three things about this API are unusual enough that
// they are encoded here rather than left to callers:
//
//  1. ERRORS ARRIVE AS HTTP 200. Over-limit requests return 200 with a body of
//     {"errorCode":-1,"errorMessage":"Exceeded limit","hits":null}. Checking the status
//     code alone silently yields zero results. assertNotLimited() is the guard.
//  2. THE DETAIL PAYLOAD IS DOUBLE-ENCODED. The real object is a JSON *string* at
//     hits.hits[0]._source.content and needs a second JSON.parse.
//  3. THERE IS NO DISTANCE. `sort=distance+asc` returns 200 and is silently ignored
//     (proved by sending sort=zzzbogus+asc and getting identical ordering). Only
//     score+desc and the name sort are real. Ranking is entirely our job.
//
// No authentication of any kind is required — not even a User-Agent. We send a
// descriptive one anyway so FINRA can identify and contact us if our traffic is a problem.

import { config } from "./config.mjs";
import { yearsInIndustry } from "./profile.mjs";

const UA = "hushh-brokercheck-api/0.1 (+https://hushh.ai; contact ankit@hushh.ai)";

export class FinraError extends Error {
  constructor(message, { status = null, code = null, retriable = false } = {}) {
    super(message);
    this.name = "FinraError";
    this.status = status;
    this.code = code;
    this.retriable = retriable;
  }
}

/** FINRA signals over-limit and validation failures inside a 200 body. Anything with a
 *  non-null errorCode or a null `hits` is a failure regardless of status. */
function assertNotLimited(body, context) {
  if (!body || typeof body !== "object") {
    throw new FinraError(`FINRA returned a non-object body (${context})`);
  }
  if (body.errorCode != null && body.errorCode !== 0) {
    throw new FinraError(`FINRA rejected the request (${context}): ${body.errorMessage || body.errorCode}`, {
      code: body.errorCode,
    });
  }
  if (body.hits == null) {
    throw new FinraError(`FINRA returned no hits envelope (${context}): ${body.errorMessage || "hits was null"}`);
  }
  return body;
}

async function getJson(url, { context }) {
  let lastError;
  for (let attempt = 0; attempt <= config.finra.retries; attempt++) {
    if (attempt > 0) {
      // Bounded exponential backoff with jitter. Deterministic base so behaviour is
      // predictable under test; the jitter only spreads concurrent retries apart.
      const wait = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": UA },
        signal: AbortSignal.timeout(config.finra.timeoutMs),
      });
      // 5xx and 429 are worth retrying; 4xx (other than 429) will not improve.
      if (response.status === 429 || response.status >= 500) {
        lastError = new FinraError(`FINRA HTTP ${response.status} (${context})`, {
          status: response.status,
          retriable: true,
        });
        continue;
      }
      if (!response.ok) {
        throw new FinraError(`FINRA HTTP ${response.status} (${context})`, { status: response.status });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof FinraError && !error.retriable) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new FinraError(`FINRA request failed (${context})`);
}

/** Build the comma-joined `filter` string BrokerCheck expects. The SPA's own builder
 *  excludes `includePrevious` and `r`, which ride as their own query params. */
export function buildFilter({ type = "ia", status = "active", minExperienceYears = null } = {}) {
  const parts = [];
  if (type === "ia") parts.push("ia=true");
  else if (type === "broker") parts.push("broker=true");
  else parts.push("broker=true", "ia=true", "brokeria=true");

  if (status === "active") parts.push("active=true");
  else if (status === "previous") parts.push("prev=true");
  else parts.push("active=true", "prev=true");

  // Experience is a DAY range, not years — the UI multiplies the slider by 365.
  // An open upper bound is "<days>-*".
  if (Number.isFinite(minExperienceYears) && minExperienceYears > 0) {
    parts.push(`experience=${Math.round(minExperienceYears * 365)}-*`);
  }
  return parts.join(",");
}

function searchUrl({ lat, lng, radiusMi, filter, nrows, start }) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng), // NOTE: FINRA's param is `lon`, not `lng`
    r: String(radiusMi), // radius in STATUTE MILES
    nrows: String(nrows),
    start: String(start),
    hl: "true",
    includePrevious: "false",
    sort: "score+desc",
    wt: "json",
  });
  if (filter) params.set("filter", filter);
  // URLSearchParams percent-encodes the '+' in "score+desc" to %2B, which FINRA accepts
  // (verified live). No manual fix-up needed.
  return `${config.finra.searchBase}/individual?${params.toString()}`;
}

/** One page of individuals near a coordinate. Returns { total, stubs }. */
export async function searchIndividuals({ lat, lng, radiusMi, filter, nrows = 100, start = 0 }) {
  const rows = Math.min(nrows, config.finra.maxRows);
  if (start > config.finra.maxStart) {
    throw new FinraError(`start=${start} exceeds FINRA's deep-paging window (${config.finra.maxStart})`);
  }
  const body = await getJson(searchUrl({ lat, lng, radiusMi, filter, nrows: rows, start }), {
    context: `search start=${start}`,
  });
  assertNotLimited(body, `search start=${start}`);
  return {
    total: Number(body.hits.total) || 0,
    stubs: (body.hits.hits || []).map(mapStub).filter(Boolean),
  };
}

/** Flatten a search hit into our stub shape. Everything here is available WITHOUT a
 *  detail fetch, which is why first paint is fast — including years of experience. */
export function mapStub(hit) {
  const s = hit?._source;
  if (!s?.ind_source_id) return null;

  // The matched branch arrives via inner_hits (the employment that satisfied the geo
  // query), which is more precise than picking ind_current_employments[0] blindly.
  const inner = hit?.inner_hits?.ind_current_employments?.hits?.hits?.[0]?._source;
  const employment = inner || (Array.isArray(s.ind_current_employments) ? s.ind_current_employments[0] : null);

  return {
    crd: String(s.ind_source_id),
    firstName: s.ind_firstname || null,
    middleName: s.ind_middlename || null,
    lastName: s.ind_lastname || null,
    name: [s.ind_firstname, s.ind_middlename, s.ind_lastname].filter(Boolean).join(" ") || null,
    otherNames: Array.isArray(s.ind_other_names) ? s.ind_other_names : [],
    brokerScope: s.ind_bc_scope || null,
    advisorScope: s.ind_ia_scope || null,
    isInvestmentAdvisor: String(s.ind_ia_scope || "").toLowerCase() === "active",
    isBroker: String(s.ind_bc_scope || "").toLowerCase() === "active",
    hasDisclosures: s.ind_bc_disclosure_fl === "Y" || s.ind_bc_disclosure_fl === true,
    finraRegistrationCount: Number(s.ind_approved_finra_registration_count) || 0,
    // Derived, and the ONLY experience signal available pre-detail. The search endpoint
    // names these differently from the detail endpoint (ind_industry_cal_date is ISO
    // YYYY-MM-DD, not the detail endpoint's M/D/YYYY) — yearsInIndustry handles both.
    yearsExperience: yearsInIndustry({ days: s.ind_industry_days, sinceDate: s.ind_industry_cal_date }),
    firm: employment
      ? {
          firmId: employment.firm_id != null ? String(employment.firm_id) : null,
          firmName: employment.firm_name || null,
          branchCity: employment.branch_city || null,
          branchState: employment.branch_state || null,
          branchZip: employment.branch_zip || null,
          iaOnly: employment.ia_only === "Y",
        }
      : null,
  };
}

/** Full profile for one CRD. Handles the double-encoded `content` field. */
export async function fetchIndividualDetail(crd) {
  // The SPA sends decorative junk params here (including a hardcoded `query=john`);
  // a bare path returns the identical payload.
  const body = await getJson(`${config.finra.searchBase}/individual/${encodeURIComponent(crd)}?wt=json`, {
    context: `detail crd=${crd}`,
  });
  assertNotLimited(body, `detail crd=${crd}`);
  const raw = body.hits.hits?.[0]?._source?.content;
  if (!raw) throw new FinraError(`No detail content for CRD ${crd}`);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/** Full record for one individual from the SEC's IAPD mirror.
 *
 *  Why this exists: BrokerCheck genuinely does NOT hold disclosures or years-of-experience for
 *  investment-adviser-only individuals (`bcScope: "NotInScope"`). Its own website says so —
 *  those results render "For Disclosures (if any) and Years of Experience visit SEC" instead of
 *  values. The data lives on IAPD, which BrokerCheck's SPA treats as a same-shaped sibling API.
 *
 *  Two differences from the BrokerCheck endpoint, both easy to miss:
 *    - the payload is at `_source.iacontent`, not `_source.content`
 *    - experience is `basicInformation.daysInIndustryCalculatedDateIAPD` — a THIRD spelling,
 *      alongside BrokerCheck's `daysInIndustry` and `daysInIndustryCalculatedDate` */
export async function fetchIndividualDetailIAPD(crd) {
  const body = await getJson(`${config.iapd.searchBase}/individual/${encodeURIComponent(crd)}?wt=json`, {
    context: `iapd crd=${crd}`,
  });
  const raw = body?.hits?.hits?.[0]?._source?.iacontent;
  if (!raw) throw new FinraError(`No IAPD detail for CRD ${crd}`);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/** Full record for one FIRM crd. Same double-encoded `content` shape as individuals.
 *  This is where contact details live — an individual's payload has a branch address but
 *  never a phone number. */
export async function fetchFirmDetail(crd) {
  const body = await getJson(`${config.finra.searchBase}/firm/${encodeURIComponent(crd)}?wt=json`, {
    context: `firm crd=${crd}`,
  });
  assertNotLimited(body, `firm crd=${crd}`);
  const raw = body.hits.hits?.[0]?._source?.content;
  if (!raw) throw new FinraError(`No firm detail for CRD ${crd}`);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/** FINRA's own ZIP/city -> coordinate resolver. Unauthenticated and undocumented.
 *  Useful for accepting a postal code as an alternative to lat/lng. */
export async function resolveLocation(query) {
  const body = await getJson(
    `${config.finra.searchBase}${config.finra.locationsPath}?query=${encodeURIComponent(query)}&results=1`,
    { context: `locations ${query}` },
  );
  const hit = body?.hits?.hits?.[0]?._source;
  if (!hit) return null;
  const lat = Number(hit.latitude);
  const lng = Number(hit.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, display: hit.display || query } : null;
}

/** Run tasks with bounded concurrency, preserving input order. Failures resolve to
 *  null rather than rejecting so one bad CRD never collapses a whole search. */
export async function pooled(items, worker, limit = config.finra.concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = null;
      }
      if (config.finra.gapMs) await new Promise((r) => setTimeout(r, config.finra.gapMs));
    }
  });
  await Promise.all(runners);
  return results;
}
