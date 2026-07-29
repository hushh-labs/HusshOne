// NPI Registry API (v2.1) client — the SECONDARY source, used only to refresh or
// enrich targeted state/ZIP slices between monthly bulk drops. The API hard-caps at
// 1200 results per query (skip 1000 + limit 200), so it CANNOT enumerate the whole
// US; the bulk file is the source of truth for coverage.
//
// buildApiUrl + mapApiResultToProvider are pure (unit-tested); searchProviders does
// the network I/O with 429 backoff.

import { config } from "./config.mjs";
import { normalizeZip } from "./zip.mjs";
import { entityTypeFromCode, taxonomyDesc } from "./nppes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
  }
}

// Build a fully-formed query URL. Clamps limit/skip to the API's hard ceilings so a
// caller can't accidentally request an out-of-range page.
export function buildApiUrl({ state, postalCode, limit = 200, skip = 0, taxonomy } = {}) {
  const u = new URL(config.api.endpoint);
  u.searchParams.set("version", config.api.version);
  if (state) u.searchParams.set("state", String(state).toUpperCase().slice(0, 2));
  if (postalCode) u.searchParams.set("postal_code", String(postalCode));
  if (taxonomy) u.searchParams.set("taxonomy_description", String(taxonomy));
  u.searchParams.set("limit", String(Math.max(1, Math.min(config.api.maxLimit, Number(limit) || 200))));
  u.searchParams.set("skip", String(Math.max(0, Math.min(config.api.maxSkip, Number(skip) || 0))));
  return u.toString();
}

// Entity type from the API's enumeration_type ("NPI-1" => individual, "NPI-2" => org).
export function entityTypeFromEnumeration(enumerationType) {
  const t = String(enumerationType ?? "").trim().toUpperCase();
  if (t === "NPI-1") return "individual";
  if (t === "NPI-2") return "organization";
  return null;
}

// Map one NPI API result object to the same provider record shape mapNppesRow emits.
// Uses the LOCATION (practice) address, never the MAILING address. Keeps the raw
// object so API-enriched rows carry the full payload.
export function mapApiResultToProvider(result, source = "npi_api") {
  if (!result) return null;
  const npi = String(result.number ?? "").trim();
  if (!/^\d{10}$/.test(npi)) return null;

  const basic = result.basic || {};
  const taxonomies = Array.isArray(result.taxonomies) ? result.taxonomies : [];
  const primary = taxonomies.find((t) => t && t.primary) || taxonomies[0] || null;

  const addresses = Array.isArray(result.addresses) ? result.addresses : [];
  const loc = addresses.find((a) => a && a.address_purpose === "LOCATION") || addresses[0] || {};

  // enumeration_type ("NPI-1"/"NPI-2") is preferred; fall back to a numeric code.
  const entityType =
    entityTypeFromEnumeration(result.enumeration_type) || entityTypeFromCode(basic.entity_type_code);

  const statusRaw = String(basic.status ?? "").trim().toUpperCase();
  const status = statusRaw === "A" ? "active" : statusRaw === "D" ? "deactivated" : statusRaw ? statusRaw.toLowerCase() : "active";

  return {
    npi,
    entityType,
    lastName: basic.last_name || null,
    firstName: basic.first_name || null,
    middleName: basic.middle_name || null,
    credential: basic.credential || null,
    organizationName: basic.organization_name || basic.name || null,
    primaryTaxonomyCode: primary?.code || null,
    primaryTaxonomyDesc: primary?.desc || (primary?.code ? taxonomyDesc(primary.code) : null),
    enumerationDate: basic.enumeration_date || null, // API already returns YYYY-MM-DD
    status,
    addressLine1: loc.address_1 || null,
    addressLine2: loc.address_2 || null,
    city: loc.city || null,
    state: (loc.state || "").toUpperCase().slice(0, 2) || null,
    zip: normalizeZip(loc.postal_code),
    phone: loc.telephone_number || null,
    source,
    raw: result,
  };
}

// Fetch one page of results. Throws RateLimitError on 429 so the caller can back off.
async function fetchPage(params) {
  const url = buildApiUrl(params);
  const res = await fetch(url, { headers: { "User-Agent": config.api.userAgent } });
  if (res.status === 429) throw new RateLimitError("NPI API 429 rate limited");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NPI API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Enumerate a state/ZIP slice, paging by skip up to the API ceiling. Returns
// { results: [...raw result], calls }. Stops at the last page or the 1200 cap.
export async function searchProviders(
  { state, postalCode, taxonomy } = {},
  { pageSize = config.api.maxLimit, maxBackoffMs = config.worker.maxBackoffMs } = {},
) {
  const results = [];
  let calls = 0;
  for (let skip = 0; skip <= config.api.maxSkip; skip += pageSize) {
    let attempt = 0;
    for (;;) {
      try {
        const data = await fetchPage({ state, postalCode, taxonomy, limit: pageSize, skip });
        calls++;
        const batch = Array.isArray(data.results) ? data.results : [];
        results.push(...batch);
        // Last page when fewer than a full page came back.
        if (batch.length < pageSize) return { results, calls, capped: false };
        break;
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err;
        attempt++;
        const backoff = Math.min(maxBackoffMs, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        console.log(JSON.stringify({ event: "npi_api.backoff", state, postalCode, attempt, backoffMs: backoff }));
        await sleep(backoff);
      }
    }
  }
  // Reached the 1200-result ceiling — slice is larger than the API can enumerate.
  return { results, calls, capped: true };
}
