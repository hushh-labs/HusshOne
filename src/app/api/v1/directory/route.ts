/* Developer API — GET /api/v1/directory
   Auth: ONE_DEV_API_KEYS (Bearer). Coordinate-driven directory search across four verticals (hotels,
   healthcare, ria, insurance) held in separate Cloud SQL databases. Returns rows within `radius` metres
   of (`lat`,`lng`), MERGED across verticals and SORTED by true geographic distance (nearest first),
   capped at a global `limit`. Every row carries a `geoPrecision` flag (`rooftop` for hotels, `zip_centroid`
   for the rest until the Phase-2 geocoding backfill upgrades them). `social` is excluded (no coordinates).

     GET /api/v1/directory?lat=47.68&lng=-122.21&radius=5000&limit=20&verticals=hotels,ria

   Backward-compat: if `lat`/`lng` are absent a `zip` is resolved to its centroid and used as the search
   point (`resolvedFrom:"zip"`). Bad/missing coordinates → 400; DB creds unset → 503 (graceful degrade). */
import { verifyDevApiRequest, apiOwnerUid } from "@/lib/auth/dev-api";
import { parseDirectoryQuery } from "@/lib/api/v1-directory";
import { V1InputError } from "@/lib/api/v1-input";
import { queryVertical, resolveZipCentroid, type DirectoryRow } from "@/lib/directory/query";
import { hasDirectoryDb } from "@/lib/directory/db";
import { apiError, apiJson, corsPreflight, statusCodeOf } from "@/lib/api/http";

export const runtime = "nodejs";
export const maxDuration = 30; // parallel PostGIS lookups; each pool has an 8s statement timeout

export function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: Request) {
  let keyId: string;
  try {
    ({ keyId } = verifyDevApiRequest(request));
  } catch (error) {
    return apiError(401, "unauthorized", error instanceof Error ? error.message : "Unauthorized");
  }

  try {
    if (!hasDirectoryDb()) {
      return apiError(503, "directory_unavailable", "Directory database is not configured");
    }

    const q = parseDirectoryQuery(new URL(request.url).searchParams);
    const warnings = [...q.warnings];

    // Resolve the search point: coordinates win; otherwise fall back to the ZIP centroid (sole ZIP path).
    let lat = q.lat;
    let lng = q.lng;
    let resolvedFrom: "coordinates" | "zip" = "coordinates";
    if ((lat === undefined || lng === undefined) && q.zip) {
      const centroid = await resolveZipCentroid(q.zip);
      if (!centroid) {
        return apiError(400, "unknown_zip", `Could not resolve \`zip\` ${q.zip} to coordinates`);
      }
      ({ lat, lng } = centroid);
      resolvedFrom = "zip";
    }
    if (lat === undefined || lng === undefined) {
      // parseDirectoryQuery guarantees coords-or-zip; this is a belt-and-braces guard.
      return apiError(400, "missing_coordinates", "Provide `latitude`+`longitude` (or `zip`)");
    }

    const params = { lat, lng, radiusM: q.radiusM, limit: q.limit };

    // Fan out one query per requested vertical (separate DBs → no cross-DB join). Each is isolated: a
    // vertical failure is recorded as a warning and never fails the whole request.
    const perVertical = await Promise.all(q.verticals.map((v) => queryVertical(v, params)));

    const merged: DirectoryRow[] = [];
    for (const result of perVertical) {
      if (result.error) warnings.push(`vertical \`${result.vertical}\` failed: ${result.error}`);
      merged.push(...result.rows);
    }

    // Merge + sort by true distance (nearest first), then apply the global limit across all verticals.
    merged.sort((a, b) => a.distanceM - b.distanceM);
    const results = merged.slice(0, q.limit);

    return apiJson({
      ok: true,
      query: {
        lat,
        lng,
        radiusM: q.radiusM,
        limit: q.limit,
        verticals: q.verticals,
        resolvedFrom,
        ...(resolvedFrom === "zip" ? { zip: q.zip } : {}),
      },
      count: results.length,
      results,
      warnings,
    });
  } catch (error) {
    const status = error instanceof V1InputError ? error.statusCode : statusCodeOf(error, 502);
    const code = error instanceof V1InputError ? error.code : "directory_query_failed";
    const message = error instanceof Error ? error.message : "Directory query failed";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({ event: "one.v1.directory_failed", severity: status >= 500 ? "ERROR" : "WARNING", keyId, owner: apiOwnerUid(keyId), status, code, message }),
    );
    return apiError(status, code, message);
  }
}
