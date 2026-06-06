import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { fetchAuditReport } from "@/lib/ria/client";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    await verifyOneRequest(request.headers.get("authorization"));
    const { jobId } = await context.params;
    if (!jobId) {
      return NextResponse.json({ ok: false, error: "Missing audit job id" }, { status: 400 });
    }
    const report = await fetchAuditReport(jobId);
    return NextResponse.json({ ok: true, report });
  } catch (error) {
    const statusCode =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 500;
    const message = error instanceof Error ? error.message : "Audit report is not ready";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
