import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getOwnedScanRun } from "@/lib/db/scan-store";

export const runtime = "nodejs";

/* Lightweight recovery endpoint: if the long result stream drops, the client
   can poll here to pick up the result the server already saved. */
export async function GET(
  request: Request,
  context: { params: Promise<{ scanRunId: string }> },
) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const { scanRunId } = await context.params;
    if (!scanRunId) {
      return NextResponse.json({ ok: false, error: "Missing scan id" }, { status: 400 });
    }

    const scan = await getOwnedScanRun(verified.uid, scanRunId);
    if (!scan) {
      return NextResponse.json({ ok: false, status: "unknown", result: null }, { status: 404 });
    }

    return NextResponse.json({
      ok: scan.status === "completed",
      status: scan.status,
      result: scan.normalizedResult ?? null,
      error: scan.error ?? null,
    });
  } catch (error) {
    const statusCode =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 401;
    const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 401;
    const message = error instanceof Error ? error.message : "Could not load scan status";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
