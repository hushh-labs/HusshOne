import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getResearchJob, completeScanRun, failScanRun, getScanEmailDelivery } from "@/lib/db/scan-store";
import { pollResearch } from "@/lib/research/client";
import { finalizeResearch } from "@/lib/research/finalize";
import { sendScanResultEmails } from "@/lib/notifications/scan-email";
import type { ScanEmailDeliverySummary } from "@/lib/notifications/types";
import type { LocationMode, OneSubjectInput } from "@/lib/ria/types";

export const runtime = "nodejs";

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

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

    const scan = await getResearchJob(verified.uid, id);
    if (!scan) {
      return NextResponse.json({ ok: false, status: "unknown", result: null }, { status: 404 });
    }
    if (scan.status === "completed") {
      const emailDelivery = await getScanEmailDelivery(verified.uid, id);
      return NextResponse.json({ ok: true, status: "completed", result: scan.normalizedResult ?? null, emailDelivery });
    }
    if (scan.status === "failed") {
      return NextResponse.json({ ok: false, status: "failed", error: scan.error ?? "Research failed", result: null });
    }

    // Still running → resume the upstream Deep Research poll.
    const stored = (scan.input ?? {}) as Partial<OneSubjectInput> & { deepResearchJobId?: string };
    const jobId = stored.deepResearchJobId;
    if (!jobId) {
      return NextResponse.json({ ok: false, status: "running", result: null });
    }

    const dr = await pollResearch(jobId);
    if (dr.status === "completed" && dr.report) {
      const mode: LocationMode =
        typeof stored.latitude === "number" && typeof stored.longitude === "number" ? "precise" : "limited";
      const result = await finalizeResearch(
        dr.report,
        dr.citations,
        {
          name: stored.name || "",
          email: stored.email || "",
          latitude: stored.latitude,
          longitude: stored.longitude,
          zipCode: stored.zipCode,
          phone: stored.phone,
          consentAttestation: true,
          purpose: "self_audit",
        },
        mode,
        id,
      );
      await completeScanRun(id, toJsonValue(result), result.summary);
      // The streaming POST normally sends the result emails, but when it was interrupted
      // (client disconnect / route timeout) THIS resume path is what completes the scan —
      // so send here too. The OneNotification unique constraint dedupes if both ever run.
      let emailDelivery: ScanEmailDeliverySummary | null = null;
      try {
        emailDelivery = await sendScanResultEmails({
          userId: scan.userId,
          scanRunId: id,
          result,
          audit: null,
          siteUrl: requestOrigin(request),
        });
      } catch (notificationError) {
        console.error(
          JSON.stringify({
            event: "one.research_email.failed",
            severity: "ERROR",
            scanRunId: id,
            message: notificationError instanceof Error ? notificationError.message : "unknown",
          }),
        );
        emailDelivery = await getScanEmailDelivery(verified.uid, id);
      }
      return NextResponse.json({ ok: true, status: "completed", result, emailDelivery });
    }
    if (dr.status === "failed") {
      await failScanRun(id, dr.error || "Deep Research could not complete").catch(() => undefined);
      return NextResponse.json({ ok: false, status: "failed", error: dr.error ?? "Research failed", result: null });
    }
    return NextResponse.json({ ok: false, status: "running", result: null });
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
