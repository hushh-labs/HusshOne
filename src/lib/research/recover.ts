/* Shared scan recovery/finalize: resume the upstream Deep Research poll, finalize (Phase-2 synthesis)
   on completion, persist, and send result emails. Extracted verbatim from the /research/[id] GET so
   BOTH that route and the v1 developer API (GET /api/v1/scan/[id]) share identical behavior. Auth is
   the caller's responsibility — this takes a resolved owner `uid` and enforces ownership via
   getResearchJob(uid, id). */
import type { Prisma } from "@prisma/client";
import { completeScanRun, failScanRun, getResearchJob, getScanEmailDelivery } from "@/lib/db/scan-store";
import { pollResearch } from "@/lib/research/client";
import { finalizeResearch } from "@/lib/research/finalize";
import { sendScanResultEmails } from "@/lib/notifications/scan-email";
import type { ScanEmailDeliverySummary } from "@/lib/notifications/types";
import { isStaleRunning } from "@/lib/ria/progress";
import type { LocationMode, OneSubjectInput } from "@/lib/ria/types";

const STALE_MESSAGE = "This scan ran past its time limit and didn't finish.";

// In-flight finalize guard (per instance). A recovering client fires several concurrent GETs; without
// this they'd all finalize the SAME job, re-running Phase-2 synthesis N× per scan. Check-then-add is
// synchronous (no await between), so only the first request per scan id proceeds on a given instance.
const finalizingNow = new Set<string>();

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export interface RecoverScanResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** Recover/finalize a scan for owner `uid`. Returns the same `{ ok, status, result, … }` envelope the
 *  web app's recovery loop already consumes. `origin` is used for result-email links (null off-host). */
export async function recoverScan(opts: { uid: string; id: string; origin: string | null }): Promise<RecoverScanResult> {
  const { uid, id, origin } = opts;

  const scan = await getResearchJob(uid, id);
  if (!scan) return { httpStatus: 404, body: { ok: false, status: "unknown", result: null } };
  if (scan.status === "completed") {
    const emailDelivery = await getScanEmailDelivery(uid, id);
    return { httpStatus: 200, body: { ok: true, status: "completed", result: scan.normalizedResult ?? null, emailDelivery } };
  }
  if (scan.status === "failed") {
    return { httpStatus: 200, body: { ok: false, status: "failed", error: scan.error ?? "Research failed", result: null } };
  }

  const stored = (scan.input ?? {}) as Partial<OneSubjectInput> & { deepResearchJobId?: string };
  const jobId = stored.deepResearchJobId;

  if (isStaleRunning(scan.status, new Date(scan.createdAt).getTime())) {
    console.error(JSON.stringify({ event: "one.research.failed", severity: "ERROR", scanRunId: id, email: stored.email || null, jobId: jobId ?? null, outcome: "failed", via: "stale_timeout", message: STALE_MESSAGE }));
    await failScanRun(id, STALE_MESSAGE, jobId ? { deepResearchJobId: jobId } : undefined).catch(() => undefined);
    return { httpStatus: 200, body: { ok: false, status: "failed", error: STALE_MESSAGE, result: null } };
  }
  if (!jobId) return { httpStatus: 200, body: { ok: false, status: "running", result: null } };

  let dr: Awaited<ReturnType<typeof pollResearch>>;
  try {
    dr = await pollResearch(jobId, { fast: true });
  } catch {
    return { httpStatus: 200, body: { ok: false, status: "running", result: null } };
  }

  if (dr.status === "completed" && dr.report) {
    if (finalizingNow.has(id)) return { httpStatus: 200, body: { ok: false, status: "running", result: null } };
    finalizingNow.add(id);
    try {
      const fresh = await getResearchJob(uid, id);
      if (fresh && fresh.status === "completed") {
        const emailDelivery = await getScanEmailDelivery(uid, id);
        return { httpStatus: 200, body: { ok: true, status: "completed", result: fresh.normalizedResult ?? null, emailDelivery } };
      }
      const mode: LocationMode = typeof stored.latitude === "number" && typeof stored.longitude === "number" ? "precise" : "limited";
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
      const totalMs = Date.now() - new Date(scan.createdAt).getTime();
      const phase1Ms = Math.max(0, totalMs - phase2Ms);
      await completeScanRun(id, toJsonValue(result), result.summary, {
        phase1Ms,
        phase2Ms,
        totalMs,
        outcome: "completed_via_recovery",
        deepResearchJobId: jobId,
      });
      console.info(JSON.stringify({ event: "one.research.completed", severity: "INFO", scanRunId: id, email: stored.email || null, jobId, phase1Ms, phase2Ms, totalMs, outcome: "completed_via_recovery", source: result.source }));
      let emailDelivery: ScanEmailDeliverySummary | null = null;
      try {
        emailDelivery = await sendScanResultEmails({ userId: scan.userId, scanRunId: id, result, audit: null, siteUrl: origin });
      } catch (notificationError) {
        console.error(JSON.stringify({ event: "one.research_email.failed", severity: "ERROR", scanRunId: id, message: notificationError instanceof Error ? notificationError.message : "unknown" }));
        emailDelivery = await getScanEmailDelivery(uid, id);
      }
      return { httpStatus: 200, body: { ok: true, status: "completed", result, emailDelivery } };
    } finally {
      finalizingNow.delete(id);
    }
  }

  if (dr.status === "failed") {
    const failMs = Date.now() - new Date(scan.createdAt).getTime();
    console.error(JSON.stringify({ event: "one.research.failed", severity: "ERROR", scanRunId: id, email: stored.email || null, jobId, phase1Ms: failMs, outcome: "failed", via: "recovery", message: dr.error ?? "Research failed" }));
    await failScanRun(id, dr.error || "Deep Research could not complete", { phase1Ms: failMs, deepResearchJobId: jobId }).catch(() => undefined);
    return { httpStatus: 200, body: { ok: false, status: "failed", error: dr.error ?? "Research failed", result: null } };
  }

  return { httpStatus: 200, body: { ok: false, status: "running", result: null } };
}
