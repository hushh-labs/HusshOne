/* Developer API — GET /api/v1/scan/{id}/preferences
   Auth: ONE_DEV_API_KEYS (Bearer). Returns the subject's 6-section preference profile + v5 lifestyle
   facts. Per-subject-safe: keyed to the subject's own synthetic user (see v1-preferences), so two
   subjects scanned under one key never see each other's data. Fast-pass is available immediately and
   upgrades to the v3 + lifestyle profile as the async pipeline finishes. */
import { verifyDevApiRequest, apiOwnerUid } from "@/lib/auth/dev-api";
import { getResearchJob } from "@/lib/db/scan-store";
import { readDevPreferences } from "@/lib/api/v1-preferences";
import { apiError, apiJson, corsPreflight } from "@/lib/api/http";
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

    const scan = await getResearchJob(uid, id);
    if (!scan) return apiJson({ ok: false, scanId: id, status: "unknown", preferences: null }, 404);

    const stored = (scan.input ?? {}) as Partial<OneSubjectInput>;
    const pref = await readDevPreferences(keyId, stored);
    return apiJson({ ok: true, scanId: id, status: pref.status, preferences: pref.profile });
  } catch (error) {
    return apiError(500, "preferences_read_failed", error instanceof Error ? error.message : "Could not load preferences");
  }
}
