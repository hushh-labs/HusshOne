/* Input validation for GET /api/v1/directory. Same spirit as v1-input.ts: parse → coerce → clamp →
   validate, throwing the SHARED V1InputError so the route's error mapping (`.statusCode`/`.code`) just
   works. Deliberately DB-free (pure + unit-testable): it validates coordinates and echoes an optional
   `zip`, but the ZIP→centroid resolution (the one retained backward-compat path) happens in the route via
   the DB layer. The endpoint is coordinate-driven; `zip` is a fallback only. */
import { V1InputError } from "@/lib/api/v1-input";
import { DIRECTORY_VERTICALS, type DirectoryVertical } from "@/lib/directory/db";

const DEFAULT_RADIUS_M = 5_000;
const MIN_RADIUS_M = 100;
const MAX_RADIUS_M = 50_000;
const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

export interface DirectoryQueryInput {
  /** Present when the caller supplied valid coordinates. */
  lat?: number;
  lng?: number;
  /** Present when the caller supplied a ZIP instead of coordinates (route resolves it to a centroid). */
  zip?: string;
  radiusM: number;
  limit: number;
  verticals: DirectoryVertical[];
  /** Non-fatal notes echoed to the caller (unknown/excluded verticals, etc.). */
  warnings: string[];
}

function firstParam(params: URLSearchParams, ...names: string[]): string {
  for (const n of names) {
    const v = params.get(n);
    if (v != null && v.trim()) return v.trim();
  }
  return "";
}

/** number OR numeric string → finite number, else undefined (mirrors asNumber in v1-input.ts). */
function toNumber(raw: string): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Parse + validate the query string. Throws V1InputError (400) on bad/missing coordinates. */
export function parseDirectoryQuery(params: URLSearchParams): DirectoryQueryInput {
  const warnings: string[] = [];

  // --- coordinates (primary) ---
  const latRaw = firstParam(params, "lat", "latitude");
  const lngRaw = firstParam(params, "lng", "lon", "longitude");
  const hasLat = latRaw !== "";
  const hasLng = lngRaw !== "";
  const zip = firstParam(params, "zip", "zipCode", "zipcode") || undefined;

  let lat: number | undefined;
  let lng: number | undefined;

  if (hasLat || hasLng) {
    if (!hasLat || !hasLng) {
      throw new V1InputError("Provide both `latitude` and `longitude`", 400, "bad_coordinates");
    }
    lat = toNumber(latRaw);
    lng = toNumber(lngRaw);
    if (lat === undefined || lng === undefined) {
      throw new V1InputError("`latitude` and `longitude` must be numbers", 400, "bad_coordinates");
    }
    if (lat < -90 || lat > 90) {
      throw new V1InputError("`latitude` must be between -90 and 90", 400, "bad_coordinates");
    }
    if (lng < -180 || lng > 180) {
      throw new V1InputError("`longitude` must be between -180 and 180", 400, "bad_coordinates");
    }
  } else if (!zip) {
    // Coordinate-driven endpoint: require coordinates, or a ZIP as the sole backward-compat fallback.
    throw new V1InputError("Provide `latitude`+`longitude` (or `zip` as a fallback)", 400, "missing_coordinates");
  }

  // --- radius (metres) ---
  const radiusRaw = toNumber(firstParam(params, "radius", "radiusM", "radius_m"));
  const radiusM = clamp(radiusRaw ?? DEFAULT_RADIUS_M, MIN_RADIUS_M, MAX_RADIUS_M);

  // --- limit (global, applied post-merge) ---
  const limitRaw = toNumber(firstParam(params, "limit"));
  const limit = clamp(Math.trunc(limitRaw ?? DEFAULT_LIMIT), MIN_LIMIT, MAX_LIMIT);

  // --- verticals (CSV; default all four coordinate verticals) ---
  const verticalsRaw = firstParam(params, "verticals", "vertical");
  let verticals: DirectoryVertical[];
  if (!verticalsRaw) {
    verticals = [...DIRECTORY_VERTICALS];
  } else {
    const requested = verticalsRaw.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
    const valid = new Set<DirectoryVertical>();
    for (const v of requested) {
      if ((DIRECTORY_VERTICALS as readonly string[]).includes(v)) {
        valid.add(v as DirectoryVertical);
      } else if (v === "social") {
        warnings.push("`social` has no coordinates and is excluded from proximity search");
      } else {
        warnings.push(`unknown vertical \`${v}\` ignored`);
      }
    }
    verticals = [...valid];
    if (!verticals.length) warnings.push("no valid verticals requested — result is empty");
  }

  return { lat, lng, zip, radiusM, limit, verticals, warnings };
}
