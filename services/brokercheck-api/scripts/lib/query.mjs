// Request parsing + validation. Pure apart from the optional postal-code resolver, which
// is injected so this module unit-tests without network.

import { config } from "./config.mjs";

export class QueryError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "QueryError";
    this.field = field;
  }
}

const TYPES = new Set(["ia", "broker", "both"]);
const STATUSES = new Set(["active", "previous", "all"]);
const GROUP_BY = new Set(["branch", "person", "auto"]);
const STREAMS = new Set(["ndjson", "sse", "off"]);

function num(params, key) {
  const raw = params.get(key);
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new QueryError(`${key} must be a number`, key);
  return value;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function pick(params, key, allowed, fallback) {
  const raw = (params.get(key) || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (!allowed.has(raw)) {
    throw new QueryError(`${key} must be one of: ${[...allowed].join(", ")}`, key);
  }
  return raw;
}

/**
 * Parse `/v1/advisors` query params.
 *
 * Accepts either explicit `lat`+`lng`, or a `postalCode` resolved through FINRA's own
 * location endpoint. Coordinates are preferred and reported as such via `resolvedFrom`,
 * because a postal code can only ever place the caller at a ZIP centroid.
 */
export async function parseQuery(params, { resolveLocation } = {}) {
  let lat = num(params, "lat");
  let lng = num(params, "lng") ?? num(params, "lon");
  let resolvedFrom = "coordinates";

  if (lat == null || lng == null) {
    const postal = (params.get("postalCode") || params.get("zip") || "").trim();
    if (!postal) {
      throw new QueryError("Provide lat and lng (or postalCode).", "lat");
    }
    if (typeof resolveLocation !== "function") {
      throw new QueryError("Postal lookup is unavailable; send lat and lng instead.", "postalCode");
    }
    const resolved = await resolveLocation(postal);
    if (!resolved) throw new QueryError(`Could not resolve postalCode "${postal}" to coordinates.`, "postalCode");
    lat = resolved.lat;
    lng = resolved.lng;
    resolvedFrom = "postal";
  }

  if (lat < -90 || lat > 90) throw new QueryError("lat must be between -90 and 90", "lat");
  if (lng < -180 || lng > 180) throw new QueryError("lng must be between -180 and 180", "lng");

  const radiusMi = clamp(num(params, "radiusMi") ?? config.search.defaultRadiusMi, 0.1, config.search.maxRadiusMi);
  const limit = Math.round(clamp(num(params, "limit") ?? config.search.defaultLimit, 1, config.search.maxLimit));
  // Pagination. Because the ranked list is cached, page 2 costs no upstream calls at all —
  // it is a slice of an ordering that was already frozen when page 1 was served, so a
  // "show 10 more" tap can never re-shuffle what the user is already looking at.
  const offset = Math.round(clamp(num(params, "offset") ?? 0, 0, config.search.candidateCeiling));
  const batchSize = Math.round(clamp(num(params, "batchSize") ?? config.search.defaultBatchSize, 1, 100));

  const minExperienceYears = num(params, "minExperienceYears");
  if (minExperienceYears != null && (minExperienceYears < 0 || minExperienceYears > 70)) {
    throw new QueryError("minExperienceYears must be between 0 and 70", "minExperienceYears");
  }

  // Detail hydration is on by default — "as much data as possible" is the point of this
  // service — but a caller who only wants the map pins can switch it off and skip N calls.
  const detailRaw = (params.get("detail") || "").trim().toLowerCase();
  const detail = detailRaw === "" ? true : !["false", "0", "no", "off"].includes(detailRaw);

  return {
    lat,
    lng,
    resolvedFrom,
    radiusMi,
    limit,
    offset,
    batchSize,
    // Firm contact (phone + office address) requires a second FINRA call per distinct
    // employer. Cheap because employers repeat heavily, but opt-out-able.
    withFirmContact: !["false", "0", "no", "off"].includes((params.get("firmContact") || "").trim().toLowerCase()),
    minExperienceYears,
    detail,
    type: pick(params, "type", TYPES, "ia"),
    status: pick(params, "status", STATUSES, "active"),
    groupBy: pick(params, "groupBy", GROUP_BY, "auto"),
    stream: pick(params, "stream", STREAMS, "ndjson"),
  };
}
