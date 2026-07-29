/* Public, key-free paging companion to GET /api/localfinder.

   The summary route returns the FIRST page (nearest 10) per vertical. This route pages deeper into ONE
   vertical at a time — the panel calls it when the user hits "next" on a card (healthcare alone can have
   thousands of rows near a point). Rows come back in the exact same SampleRow shape as the summary (via
   the shared toSampleRow), including the expand-in-place `detail` bag, so the client renders them
   identically.

     GET /api/localfinder/rows?vertical=healthcare&lat=47.68&lng=-122.21&radius=5000&page=1&pageSize=10
     GET /api/localfinder/rows?vertical=hotels&zip=98033&page=0

   It shares the same in-memory per-IP rate limiter as the summary route (one budget per client, so paging
   can't be used to sidestep it), the same coordinate/ZIP validation, and the same failure posture. */
import { parseDirectoryQuery } from "@/lib/api/v1-directory";
import { V1InputError } from "@/lib/api/v1-input";
import { queryVertical, resolveZipCentroid } from "@/lib/directory/query";
import { hasDirectoryDb, DIRECTORY_VERTICALS, type DirectoryVertical } from "@/lib/directory/db";
import { toSampleRow } from "@/lib/directory/summary";
import { apiError, apiJson, corsPreflight, statusCodeOf } from "@/lib/api/http";
import { clientIp, rateLimited } from "@/lib/api/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
// Upper bound on the page index. Bounds the OFFSET walk (deep KNN pagination has real per-page cost) and
// turns absurd client input (page=1e309 → Infinity → an unparseable bigint offset pg would 502 on) into a
// clean 400 instead of internal error-log noise. 1000 pages × 50 rows sits far past any real result depth.
const MAX_PAGE = 1000;

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

    const params = new URL(request.url).searchParams;

    // Exactly one vertical — this route pages a single card at a time (unlike the summary's fan-out).
    const verticalRaw = (params.get("vertical") ?? "").trim().toLowerCase();
    if (!(DIRECTORY_VERTICALS as readonly string[]).includes(verticalRaw)) {
      return apiError(400, "bad_vertical", `Provide one of: ${DIRECTORY_VERTICALS.join(", ")}`);
    }
    const vertical = verticalRaw as DirectoryVertical;

    // Reuse the shared validator for coordinates / radius / zip (identical rules to summary + v1 API).
    const q = parseDirectoryQuery(params);
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

    // Paging: page is a non-negative integer ≤ MAX_PAGE; pageSize clamped to [1, 50]. offset = page*pageSize.
    // A negative page floors to 0 (lenient); a non-finite or over-range page is a client error → 400 (never
    // an Infinity/huge offset that reaches pg and surfaces as an internal 502).
    const pageNum = Math.trunc(Number(params.get("page")) || 0);
    if (!Number.isFinite(pageNum) || pageNum > MAX_PAGE) {
      return apiError(400, "bad_page", `page must be an integer between 0 and ${MAX_PAGE}`);
    }
    const page = Math.max(0, pageNum);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.trunc(Number(params.get("pageSize")) || DEFAULT_PAGE_SIZE)),
    );
    const offset = page * pageSize;

    const result = await queryVertical(vertical, { lat, lng, radiusM: q.radiusM, limit: pageSize, offset });
    if (result.error) {
      // queryVertical never throws — a per-vertical failure surfaces here as a 502.
      console.error(
        JSON.stringify({ event: "one.localfinder_rows_failed", severity: "ERROR", vertical, message: result.error }),
      );
      return apiError(502, "directory_query_failed", `Directory query failed for ${vertical}`);
    }

    return apiJson({
      ok: true,
      vertical,
      query: {
        lat,
        lng,
        radiusM: q.radiusM,
        resolvedFrom,
        ...(resolvedFrom === "zip" ? { zip: q.zip } : {}),
      },
      page,
      pageSize,
      rows: result.rows.map(toSampleRow),
      warnings,
    });
  } catch (error) {
    const status = error instanceof V1InputError ? error.statusCode : statusCodeOf(error, 502);
    const code = error instanceof V1InputError ? error.code : "directory_query_failed";
    const message = error instanceof Error ? error.message : "Directory rows lookup failed";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({
        event: "one.localfinder_rows_failed",
        severity: status >= 500 ? "ERROR" : "WARNING",
        status,
        code,
        message,
      }),
    );
    return apiError(status, code, message);
  }
}
