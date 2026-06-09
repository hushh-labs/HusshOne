import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getLatestScanForUser, getScanEmailDelivery } from "@/lib/db/scan-store";

export const runtime = "nodejs";

/* Returns the requesting user's most recent scan so the client can re-attach
   after a full app close (no local scan id). Responds 200 with status:"none"
   when there are no scans yet — distinct from the by-id route's 404 ("unknown
   id") so the client treats it as "nothing to recover", not an error.
   NOTE: static `latest` resolves before the dynamic `[scanRunId]` segment, and
   scan ids are UUIDs, so there is no routing collision. */
export async function GET(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const scan = await getLatestScanForUser(verified.uid);
    if (!scan) {
      return NextResponse.json({ ok: false, status: "none", scanRunId: null, result: null });
    }
    const emailDelivery = scan.status === "completed" ? await getScanEmailDelivery(verified.uid, scan.id) : null;
    return NextResponse.json({
      ok: scan.status === "completed",
      status: scan.status,
      scanRunId: scan.id,
      createdAt: scan.createdAt?.toISOString() ?? null, // lets the client resume the elapsed timer correctly
      result: scan.normalizedResult ?? null,
      error: scan.error ?? null,
      emailDelivery,
    });
  } catch (error) {
    const statusCode =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 401;
    const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 401;
    const message = error instanceof Error ? error.message : "Could not load latest scan";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
