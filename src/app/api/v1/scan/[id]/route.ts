/* Developer API — GET /api/v1/scan/{id}
   Auth: ONE_DEV_API_KEYS (Bearer). Returns the scraped per-platform contracts (echoed from the scan
   input) plus One's NATIVE dossier result (OneDashboardResult) — driving finalize via the shared
   recoverScan() — AND the preference/lifestyle profile (per-subject; fast-pass → v3 + lifestyle).
   Ownership is enforced: a key only sees scans it created. Poll until status is completed/failed, or
   use GET /api/v1/scan/{id}/stream for live SSE. */
import { verifyDevApiRequest, apiOwnerUid } from "@/lib/auth/dev-api";
import { recoverScan } from "@/lib/research/recover";
import { getResearchJob } from "@/lib/db/scan-store";
import { readDevPreferences } from "@/lib/api/v1-preferences";
import { apiError, apiJson, corsPreflight, requestOrigin } from "@/lib/api/http";
import type { OneSubjectInput } from "@/lib/ria/types";

export const runtime = "nodejs";

export function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let keyId: string;
  try {
    ({ keyId } = verifyDevApiRequest(request));
  } catch (error) {
    return apiError(401, "unauthorized", error instanceof Error ? error.message : "Unauthorized");
  }

  try {
    const { id } = await context.params;
    if (!id) return apiError(400, "invalid_input", "Missing scan id");
    const uid = apiOwnerUid(keyId);

    const { httpStatus, body } = await recoverScan({ uid, id, origin: requestOrigin(request) });
    if (httpStatus === 404) {
      return apiJson({ ok: false, scanId: id, status: "unknown", result: null }, 404);
    }

    // Echo the scraped contracts saved at POST time + read the per-subject preference/lifestyle profile.
    const scan = await getResearchJob(uid, id);
    const stored = (scan?.input ?? {}) as { apiProfiles?: unknown } & Partial<OneSubjectInput>;
    const profiles = stored.apiProfiles ?? { linkedin: null, instagram: null, threads: null, x: null };
    const pref = await readDevPreferences(keyId, stored).catch(() => ({ status: "skipped" as const, profile: null }));

    return apiJson(
      {
        ok: Boolean(body.ok),
        scanId: id,
        status: body.status,
        profiles,
        result: body.result ?? null,
        preferences: { status: pref.status, profile: pref.profile },
        ...(body.error ? { error: body.error } : {}),
      },
      httpStatus,
    );
  } catch (error) {
    return apiError(500, "scan_read_failed", error instanceof Error ? error.message : "Could not load scan");
  }
}
