// Request parsing + validation. Pure — unit-testable without network.
//
// The upstream takes a text `q` (a ZIP or "City, ST"), geocoded server-side. We accept
// either a postalCode (→ q directly) or lat/lng from the app (→ q = "lat,lng", which the
// locator's geocoder resolves). `radiusMi` is an optional CLIENT-SIDE filter applied to the
// API's own per-result miles, since the endpoint has no radius parameter.

import { config } from "./config.mjs";

export class QueryError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "QueryError";
    this.field = field;
  }
}

const STREAMS = new Set(["ndjson", "sse", "off"]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function num(params, key) {
  const raw = params.get(key);
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new QueryError(`${key} must be a number`, key);
  return value;
}

export function parseQuery(params) {
  const postal = (params.get("postalCode") || params.get("zip") || params.get("q") || "").trim();
  const lat = num(params, "lat");
  const lng = num(params, "lng") ?? num(params, "lon");

  let q;
  let resolvedFrom;
  if (postal) {
    q = postal;
    resolvedFrom = "postal";
  } else if (lat != null && lng != null) {
    if (lat < -90 || lat > 90) throw new QueryError("lat must be between -90 and 90", "lat");
    if (lng < -180 || lng > 180) throw new QueryError("lng must be between -180 and 180", "lng");
    q = `${lat},${lng}`;
    resolvedFrom = "coordinates";
  } else {
    throw new QueryError("Provide postalCode (or a ZIP), or lat and lng.", "postalCode");
  }

  const radiusMi = num(params, "radiusMi");
  if (radiusMi != null && (radiusMi <= 0 || radiusMi > config.search.maxRadiusMi)) {
    throw new QueryError(`radiusMi must be between 0 and ${config.search.maxRadiusMi}`, "radiusMi");
  }

  const limit = Math.round(clamp(num(params, "limit") ?? config.search.defaultLimit, 1, config.search.maxLimit));
  const offset = Math.round(clamp(num(params, "offset") ?? 0, 0, config.search.candidateCeiling));
  const batchSize = Math.round(clamp(num(params, "batchSize") ?? config.search.defaultBatchSize, 1, 100));

  const streamRaw = (params.get("stream") || "").trim().toLowerCase();
  const stream = streamRaw ? (STREAMS.has(streamRaw) ? streamRaw : null) : "ndjson";
  if (!stream) throw new QueryError(`stream must be one of: ${[...STREAMS].join(", ")}`, "stream");

  return { q, resolvedFrom, lat, lng, radiusMi: radiusMi ?? config.search.defaultRadiusMi, limit, offset, batchSize, stream };
}
