import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getResearchJob, completeScanRun, failScanRun, getScanEmailDelivery } from "@/lib/db/scan-store";
import { pollResearch } from "@/lib/research/client";
import { finalizeResearch } from "@/lib/research/finalize";
import { sendScanResultEmails } from "@/lib/notifications/scan-email";
import type { ScanEmailDeliverySummary } from "@/lib/notifications/types";
import { isStaleRunning } from "@/lib/ria/progress";
import type { LocationMode, OneSubjectInput } from "@/lib/ria/types";

const STALE_MESSAGE = "This scan ran past its time limit and didn't finish.";

export const runtime = "nodejs";

// In-flight finalize guard (per instance). A client in recovery fires several concurrent GETs
// (poll loop + visibility re-checks + refreshes); without this they'd all finalize the SAME job,
// re-running Opus synthesis 5× per scan. Check-then-add is synchronous (no await between), so only
// the first request per scan id proceeds on a given instance.
const finalizingNow = new Set<string>();

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

    // ...unless it's been "running" far past the hard wall + recovery grace: the upstream
    // job is dead/abandoned and resuming the poll would never terminate (it would just keep
    // returning "running", which the client resumes as the eternal progress screen). Fail it
    // and self-heal the row. This also caps the cross-instance re-finalize storm that a very
    // old row triggers when the upstream finally answers hours later.
    if (isStaleRunning(scan.status, new Date(scan.createdAt).getTime())) {
      console.error(
        JSON.stringify({
          event: "one.research.failed",
          severity: "ERROR",
          scanRunId: id,
          email: stored.email || null,
          jobId: jobId ?? null,
          outcome: "failed",
          via: "stale_timeout",
          message: STALE_MESSAGE,
        }),
      );
      await failScanRun(id, STALE_MESSAGE, jobId ? { deepResearchJobId: jobId } : undefined).catch(() => undefined);
      return NextResponse.json({ ok: false, status: "failed", error: STALE_MESSAGE, result: null });
    }
    if (!jobId) {
      return NextResponse.json({ ok: false, status: "running", result: null });
    }

    // Fast status poll: a snappy reconnect beats blocking for minutes on a slow upstream
    // status endpoint. If the check is slow/errors, report "running" so the client retries.
    let dr;
    try {
      dr = await pollResearch(jobId, { fast: true });
    } catch {
      return NextResponse.json({ ok: false, status: "running", result: null });
    }
    if (dr.status === "completed" && dr.report) {
      // Only one finalize per scan id may run at a time on this instance (dedupes the
      // concurrent-recovery race that ran Opus synthesis 5× per scan).
      if (finalizingNow.has(id)) {
        return NextResponse.json({ ok: false, status: "running", result: null });
      }
      finalizingNow.add(id);
      try {
        // A finalize on this instance may have completed between the poll and this claim.
        const fresh = await getResearchJob(verified.uid, id);
        if (fresh && fresh.status === "completed") {
          const emailDelivery = await getScanEmailDelivery(verified.uid, id);
          return NextResponse.json({ ok: true, status: "completed", result: fresh.normalizedResult ?? null, emailDelivery });
        }
        const mode: LocationMode =
          typeof stored.latitude === "number" && typeof stored.longitude === "number" ? "precise" : "limited";
        const { result, phase2Ms } = await finalizeResearch(
          dr.report,
          dr.citations,
          {
            name: stored.name || "",
            email: stored.email || "",
            latitude: stored.latitude,
            longitude: stored.longitude,
            zipCode: stored.zipCode,
            phone: stored.phone,
            confirmedProfiles: stored.confirmedProfiles,
            linkedinProfile: stored.linkedinProfile,
            socialProfiles: stored.socialProfiles,
            consentAttestation: true,
            purpose: "self_audit",
          },
          mode,
          id,
        );
        // Recovery completes a scan whose original stream was cut (deadline/disconnect).
        // We can't see the exact Phase-1 boundary from here, so approximate from the scan's
        // creation time: total = now − createdAt, phase1 ≈ total − phase2.
        const totalMs = Date.now() - new Date(scan.createdAt).getTime();
        const phase1Ms = Math.max(0, totalMs - phase2Ms);
        await completeScanRun(id, toJsonValue(result), result.summary, {
          phase1Ms,
          phase2Ms,
          totalMs,
          outcome: "completed_via_recovery",
          deepResearchJobId: jobId,
        });
        console.info(
          JSON.stringify({
            event: "one.research.completed",
            severity: "INFO",
            scanRunId: id,
            email: stored.email || null,
            jobId,
            phase1Ms,
            phase2Ms,
            totalMs,
            outcome: "completed_via_recovery",
            source: result.source,
          }),
        );
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
      } finally {
        finalizingNow.delete(id);
      }
    }
    if (dr.status === "failed") {
      const failMs = Date.now() - new Date(scan.createdAt).getTime();
      console.error(
        JSON.stringify({
          event: "one.research.failed",
          severity: "ERROR",
          scanRunId: id,
          email: stored.email || null,
          jobId,
          phase1Ms: failMs,
          outcome: "failed",
          via: "recovery",
          message: dr.error ?? "Research failed",
        }),
      );
      await failScanRun(id, dr.error || "Deep Research could not complete", {
        phase1Ms: failMs,
        deepResearchJobId: jobId,
      }).catch(() => undefined);
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
