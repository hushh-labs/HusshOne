/* Developer API — GET /api/v1/scan/{id}
   Auth: ONE_DEV_API_KEYS (Bearer). Returns the scraped per-platform contracts (echoed from the scan
   input) plus One's NATIVE dossier result (OneDashboardResult), driving finalize via the shared
   recoverScan(). Ownership is enforced — a key only sees scans it created. The preference layer is
   intentionally stripped (this API doesn't use it). Poll until status is completed/failed. */
import { NextResponse } from "next/server";
import { verifyDevApiRequest, apiOwnerUid } from "@/lib/auth/dev-api";
import { recoverScan } from "@/lib/research/recover";
import { getResearchJob } from "@/lib/db/scan-store";

export const runtime = "nodejs";

function requestOrigin(request: Request): string | null {
  const explicit = request.headers.get("origin");
  if (explicit?.startsWith("http")) return explicit.replace(/\/+$/, "");
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  if (!host) return null;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) return null;
  return `${proto}://${host}`;
}

// This API doesn't use the preference layer — drop its fields so the contract stays clean.
const PREFERENCE_FIELDS = ["preferenceProfile", "preferenceStatus", "preferenceVersion", "preferenceInputHash", "preferenceStartedAt", "preferenceSynthesisVersion", "preferenceSynthesisModel", "preferenceProfileV3"];

function stripPreference(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const clone: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  for (const field of PREFERENCE_FIELDS) delete clone[field];
  return clone;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let keyId: string;
  try {
    ({ keyId } = verifyDevApiRequest(request));
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    if (!id) return NextResponse.json({ ok: false, error: "Missing scan id" }, { status: 400 });
    const uid = apiOwnerUid(keyId);

    const { httpStatus, body } = await recoverScan({ uid, id, origin: requestOrigin(request) });
    if (httpStatus === 404) {
      return NextResponse.json({ ok: false, scanId: id, status: "unknown", result: null }, { status: 404 });
    }

    // Echo the scraped contracts saved at POST time (apiProfiles), and strip the preference layer.
    const scan = await getResearchJob(uid, id);
    const stored = (scan?.input ?? {}) as { apiProfiles?: unknown };
    const profiles = stored.apiProfiles ?? { linkedin: null, instagram: null, threads: null, x: null };

    return NextResponse.json(
      {
        ok: Boolean(body.ok),
        scanId: id,
        status: body.status,
        profiles,
        result: stripPreference(body.result),
        ...(body.error ? { error: body.error } : {}),
      },
      { status: httpStatus },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load scan";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
