/* User-initiated "Refresh my intelligence" (Settings button): re-pull the recent window for every connected
   platform (IG/Threads/X feeds + LinkedIn posts) and recompute, so a user who just posted sees it reflected
   without a re-scan. Thin wrapper over enqueueManualRefresh (consent-gated, anti-thrash, fully defensive). */
import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { enqueueManualRefresh } from "@/lib/social-intelligence/connect-pipeline";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const result = await enqueueManualRefresh(verified.uid);
    // 200 even on no_consent/nothing_connected — it's a benign "nothing to refresh", not an error.
    return NextResponse.json(result);
  } catch (error) {
    const statusCode =
      typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : NaN;
    const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 401;
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unauthorized" }, { status });
  }
}
