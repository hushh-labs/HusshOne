/* Public, key-free directory lookup powering the /localfinder panel.

   This is the ONLY unauthenticated view of the directory data. It is deliberately a DEMO shape, not a
   firehose: per-vertical counts, a small nearest-sample per vertical, and a healthcare specialty
   histogram (see @/lib/directory/summary). The full per-row API stays behind the Bearer-gated
   GET /api/v1/directory — this route never touches or exposes a dev API key.

     GET /api/localfinder?zip=98033
     GET /api/localfinder?lat=47.68&lng=-122.21&radius=5000

   It reuses the same input validator and ZIP→centroid resolver as the Bearer API, so coordinate rules,
   radius/limit clamping and vertical selection behave identically. A small in-memory per-IP rate limit
   keeps casual abuse off the shared directories DB; it is best-effort (per Cloud Run instance) by design. */
import { parseDirectoryQuery } from "@/lib/api/v1-directory";
import { V1InputError } from "@/lib/api/v1-input";
import { resolveZipCentroid } from "@/lib/directory/query";
import { hasDirectoryDb } from "@/lib/directory/db";
import { directorySummary } from "@/lib/directory/summary";
import { apiError, apiJson, corsPreflight, statusCodeOf } from "@/lib/api/http";
import { clientIp, rateLimited } from "@/lib/api/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

export function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: Request) {
  try {
    if (rateLimited(clientIp(request))) {
      return apiError(429, "rate_limited", "Too many requests — slow down and try again shortly.");
    }
    if (!hasDirectoryDb()) {
      return apiError(503, "directory_unavailable", "Directory database is not configured");
    }

    const q = parseDirectoryQuery(new URL(request.url).searchParams);
    const warnings = [...q.warnings];

    // Resolve the search point: coordinates win; otherwise fall back to the ZIP centroid.
    let lat = q.lat;
    let lng = q.lng;
    let resolvedFrom: "coordinates" | "zip" = "coordinates";
    if ((lat === undefined || lng === undefined) && q.zip) {
      const centroid = await resolveZipCentroid(q.zip);
      if (!centroid) {
        return apiError(400, "unknown_zip", `Could not resolve zip ${q.zip} to coordinates`);
      }
      ({ lat, lng } = centroid);
      resolvedFrom = "zip";
    }
    if (lat === undefined || lng === undefined) {
      return apiError(400, "missing_coordinates", "Provide latitude+longitude (or zip)");
    }

    const summary = await directorySummary(
      { lat, lng, radiusM: q.radiusM, sampleLimit: 10, specialtyLimit: 8 },
      q.verticals,
    );

    return apiJson({
      ok: true,
      query: {
        lat,
        lng,
        radiusM: q.radiusM,
        resolvedFrom,
        ...(resolvedFrom === "zip" ? { zip: q.zip } : {}),
      },
      totals: summary.totals,
      verticals: summary.verticals,
      healthcareSpecialties: summary.healthcareSpecialties,
      warnings: [...warnings, ...summary.warnings],
    });
  } catch (error) {
    const isInput = error instanceof V1InputError;
    const status = isInput ? error.statusCode : statusCodeOf(error, 502);
    const code = isInput ? error.code : "directory_query_failed";
    // Log the real error server-side; NEVER return a raw internal/DB message (e.g. a pg auth/connection
    // failure from resolveZipCentroid) to an unauthenticated client. V1InputError messages are safe
    // validation copy, so those alone pass through verbatim.
    const logMessage = error instanceof Error ? error.message : "Directory lookup failed";
    const clientMessage = isInput ? logMessage : "Directory lookup failed";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({ event: "one.localfinder_failed", severity: status >= 500 ? "ERROR" : "WARNING", status, code, message: logMessage }),
    );
    return apiError(status, code, clientMessage);
  }
}
