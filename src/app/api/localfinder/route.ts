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

export const runtime = "nodejs";
export const maxDuration = 30;

// --- best-effort in-memory rate limit (per instance): N requests / window per client IP ---
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const globalForRate = globalThis as unknown as { __localfinderHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (globalForRate.__localfinderHits ??= new Map());

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Returns true when this IP is over budget. Uses Date.now() (route runtime, not a workflow script). */
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5_000) {
    // bound memory: drop the oldest-touched entries
    for (const key of hits.keys()) {
      if (hits.size <= 2_500) break;
      hits.delete(key);
    }
  }
  return recent.length > RATE_LIMIT;
}

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
      { lat, lng, radiusM: q.radiusM, sampleLimit: 5, specialtyLimit: 8 },
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
    const status = error instanceof V1InputError ? error.statusCode : statusCodeOf(error, 502);
    const code = error instanceof V1InputError ? error.code : "directory_query_failed";
    const message = error instanceof Error ? error.message : "Directory lookup failed";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({ event: "one.localfinder_failed", severity: status >= 500 ? "ERROR" : "WARNING", status, code, message }),
    );
    return apiError(status, code, message);
  }
}
