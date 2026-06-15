import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getResearchJob, updateDeepTier } from "@/lib/db/scan-store";
import { startResearch, pollResearch, type ResearchDepth } from "@/lib/research/client";
import { buildDeepBatchQuestion, DEEP_BATCHES } from "@/lib/research/dossier";
import type { OneDashboardResult, OneSubjectInput } from "@/lib/ria/types";

export const runtime = "nodejs";
// Each call only START-or-POLLs (the DR job runs on the DR service); keep it snappy.
export const maxDuration = 120;

// Per-instance guard: only one batch-advance (the append + cursor bump) per scan id at a time,
// so concurrent client polls can't double-append. Check-then-add is synchronous (no await).
const advancing = new Set<string>();

// A single deep batch that's been in flight too long is treated as failed → skip + advance,
// so the deep tier never wedges on one stuck DR job.
const DEEP_BATCH_STALE_MS = 25 * 60 * 1000;

function deepDepth(): ResearchDepth {
  return process.env.DEEP_TIER_DEPTH === "max" ? "max" : "fast";
}

function statusCodeOf(error: unknown): number {
  if (typeof error === "object" && error && "statusCode" in error) {
    const n = Number((error as { statusCode?: number }).statusCode);
    if (Number.isFinite(n) && n >= 400) return n;
  }
  return 401;
}

/* Progressive Tier-2 ("deep") endpoint. The client polls this after the fast Tier-1 dossier
   shows. Per call it advances ONE step of a small state machine over DEEP_BATCHES:
   start the next batch's DR job → poll it → on completion append its markdown to deepReport,
   bump the cursor, clear the job (next call starts the next batch) → when all batches are done,
   deepStatus = "completed". Deep state lives inside ScanRun.normalizedResult (jsonb), so the
   existing recovery/restore paths return it for free. Idempotent + self-healing. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const { id } = await context.params;
    if (!id) return NextResponse.json({ ok: false, error: "Missing scan id" }, { status: 400 });

    const scan = await getResearchJob(verified.uid, id);
    if (!scan) return NextResponse.json({ ok: false, status: "unknown", result: null }, { status: 404 });

    // The deep tier only runs once Tier-1 has completed and we have a result to build on.
    if (
      scan.status !== "completed" ||
      !scan.normalizedResult ||
      typeof scan.normalizedResult !== "object" ||
      Array.isArray(scan.normalizedResult)
    ) {
      return NextResponse.json({ ok: false, deepStatus: "pending", result: null });
    }

    const result = scan.normalizedResult as OneDashboardResult & Record<string, unknown>;

    // Terminal states → echo as-is.
    if (result.deepStatus === "completed" || result.deepStatus === "failed") {
      return NextResponse.json({ ok: true, deepStatus: result.deepStatus, result });
    }

    const cursor = typeof result.deepCursor === "number" ? result.deepCursor : 0;
    if (cursor >= DEEP_BATCHES.length) {
      const merged = await updateDeepTier(verified.uid, id, { deepStatus: "completed", deepJobId: null });
      return NextResponse.json({ ok: true, deepStatus: "completed", result: merged ?? result });
    }

    const stored = (scan.input ?? {}) as Partial<OneSubjectInput>;
    const subject: OneSubjectInput = {
      name: stored.name || result.subject?.name || "",
      email: stored.email || result.subject?.email || "",
      latitude: stored.latitude,
      longitude: stored.longitude,
      zipCode: stored.zipCode,
      phone: stored.phone,
      confirmedProfiles: stored.confirmedProfiles,
      linkedinProfile: stored.linkedinProfile,
      socialProfiles: stored.socialProfiles,
      consentAttestation: true,
      purpose: "self_audit",
    };
    const tier1 = result.report || "";
    const batch = DEEP_BATCHES[cursor];

    // No in-flight job for this batch → start one.
    if (!result.deepJobId) {
      const { jobId } = await startResearch(buildDeepBatchQuestion(subject, tier1, batch), deepDepth());
      const merged = await updateDeepTier(verified.uid, id, {
        deepStatus: "running",
        deepJobId: jobId,
        deepCursor: cursor,
        deepStartedAt: Date.now(),
      });
      return NextResponse.json({ ok: true, deepStatus: "running", batch: batch.key, result: merged ?? result });
    }

    // A batch stuck in flight too long → skip it and advance (don't wedge the deep tier).
    if (typeof result.deepStartedAt === "number" && Date.now() - result.deepStartedAt > DEEP_BATCH_STALE_MS) {
      const nextCursor = cursor + 1;
      const done = nextCursor >= DEEP_BATCHES.length;
      const merged = await updateDeepTier(verified.uid, id, {
        deepCursor: nextCursor,
        deepJobId: null,
        deepStartedAt: undefined,
        deepStatus: done ? "completed" : "running",
      });
      return NextResponse.json({ ok: true, deepStatus: done ? "completed" : "running", result: merged ?? result });
    }

    // Poll the in-flight batch job (fast: a slow check just reads as "still running").
    let dr;
    try {
      dr = await pollResearch(result.deepJobId, { fast: true });
    } catch {
      return NextResponse.json({ ok: true, deepStatus: "running", result });
    }

    if (dr.status === "completed" && dr.report) {
      // Serialize the append so two concurrent polls can't double-advance.
      if (advancing.has(id)) return NextResponse.json({ ok: true, deepStatus: "running", result });
      advancing.add(id);
      try {
        // Re-read: another request may have advanced between our poll and the claim.
        const fresh = await getResearchJob(verified.uid, id);
        const fr = (fresh?.normalizedResult ?? result) as OneDashboardResult & Record<string, unknown>;
        const frCursor = typeof fr.deepCursor === "number" ? fr.deepCursor : 0;
        if (frCursor > cursor || !fr.deepJobId) {
          return NextResponse.json({ ok: true, deepStatus: fr.deepStatus ?? "running", result: fr });
        }
        const appended = `${fr.deepReport ? `${fr.deepReport}\n\n` : ""}${dr.report.trim()}`.trim();
        const nextCursor = cursor + 1;
        const done = nextCursor >= DEEP_BATCHES.length;
        const citations = [
          ...(Array.isArray(fr.deepCitations) ? fr.deepCitations : []),
          ...(Array.isArray(dr.citations) ? dr.citations : []),
        ];
        const merged = await updateDeepTier(verified.uid, id, {
          deepReport: appended,
          deepCitations: citations,
          deepCursor: nextCursor,
          deepJobId: null,
          deepStartedAt: undefined,
          deepStatus: done ? "completed" : "running",
        });
        console.info(
          JSON.stringify({
            event: "one.research.deep_batch",
            severity: "INFO",
            scanRunId: id,
            batch: batch.key,
            cursor: nextCursor,
            done,
          }),
        );
        return NextResponse.json({ ok: true, deepStatus: done ? "completed" : "running", result: merged ?? fr });
      } finally {
        advancing.delete(id);
      }
    }

    if (dr.status === "failed") {
      // Skip the failed batch and advance — one batch failing must not sink the whole deep tier.
      const nextCursor = cursor + 1;
      const done = nextCursor >= DEEP_BATCHES.length;
      const merged = await updateDeepTier(verified.uid, id, {
        deepCursor: nextCursor,
        deepJobId: null,
        deepStartedAt: undefined,
        deepStatus: done ? "completed" : "running",
      });
      return NextResponse.json({ ok: true, deepStatus: done ? "completed" : "running", result: merged ?? result });
    }

    return NextResponse.json({ ok: true, deepStatus: "running", result });
  } catch (error) {
    const status = statusCodeOf(error);
    const message = error instanceof Error ? error.message : "Could not advance the deep tier";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
