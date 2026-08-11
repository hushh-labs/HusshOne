/**
 * Query parsing for /v1/insiders.
 *
 * Accepts explicit lat+lng, or a postcode resolved through the bundled Census
 * gazetteer. `resolvedFrom` is reported back so a caller can tell which they got —
 * a postcode can only ever place them at a ZIP centroid.
 */

import { config } from "./config.mjs";
import { resolveZip } from "./geo.mjs";

export class QueryError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "QueryError";
    this.field = field;
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const num = (params, key) => {
  const raw = (params.get(key) || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new QueryError(`${key} must be a number`, key);
  return parsed;
};

export function parseQuery(params, dataDir) {
  let lat = num(params, "lat");
  let lng = num(params, "lng") ?? num(params, "lon");
  let resolvedFrom = "coordinates";

  if (lat == null || lng == null) {
    const postal = (params.get("zip") || params.get("postalCode") || "").trim();
    if (!postal) throw new QueryError("Provide lat and lng, or zip.", "zip");

    const resolved = resolveZip(postal, dataDir);
    if (!resolved) throw new QueryError(`Could not resolve zip "${postal}".`, "zip");

    lat = resolved.lat;
    lng = resolved.lng;
    resolvedFrom = "postal";
  }

  if (lat < -90 || lat > 90) throw new QueryError("lat must be between -90 and 90", "lat");
  if (lng < -180 || lng > 180) throw new QueryError("lng must be between -180 and 180", "lng");

  const minValue = num(params, "minValue") ?? 0;
  if (minValue < 0) throw new QueryError("minValue must not be negative", "minValue");

  return {
    lat,
    lng,
    resolvedFrom,
    radiusMi: clamp(num(params, "radiusMi") ?? config.search.defaultRadiusMi, 0.1, config.search.maxRadiusMi),
    limit: Math.round(clamp(num(params, "limit") ?? config.search.defaultLimit, 1, config.search.maxLimit)),
    offset: Math.round(clamp(num(params, "offset") ?? 0, 0, 10000)),
    minValue,
    stream: (params.get("stream") || "ndjson").trim().toLowerCase() === "json" ? "json" : "ndjson",
  };
}
