import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { recoverScan } from "@/lib/research/recover";

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

/* Recovery / resume endpoint: if the streamed POST dropped (e.g. a long job past
   the route timeout), the client polls here. Returns the saved result, or resumes
   the upstream Deep Research poll and persists on completion. Same response shape
   as /api/one/scans/[scanRunId] so the client's recovery loop is reused. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ ok: false, error: "Missing scan id" }, { status: 400 });
    }

    const { httpStatus, body } = await recoverScan({ uid: verified.uid, id, origin: requestOrigin(request) });
    return NextResponse.json(body, { status: httpStatus });
  } catch (error) {
    const statusCode =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 401;
    const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 401;
    const message = error instanceof Error ? error.message : "Could not load research status";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
