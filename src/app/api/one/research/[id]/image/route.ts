import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { getResearchJob, updateDeepTier } from "@/lib/db/scan-store";
import { startResearch, pollResearch, type ResearchDepth } from "@/lib/research/client";
import {
  buildImageBatchQuestion,
  hasSignal,
  renderWebDetection,
  runWebDetection,
  visionConfigured,
} from "@/lib/research/image-intel";
import type { OneDashboardResult, OneSubjectInput } from "@/lib/ria/types";

export const runtime = "nodejs";
// Each call only runs the (fast) Vision call or START-or-POLLs the synth job; keep it snappy.
export const maxDuration = 120;

const advancing = new Set<string>();
const IMAGE_STALE_MS = 20 * 60 * 1000;

function imageDepth(): ResearchDepth {
  return process.env.DEEP_TIER_DEPTH === "max" ? "max" : "fast";
}

function statusCodeOf(error: unknown): number {
  if (typeof error === "object" && error && "statusCode" in error) {
    const n = Number((error as { statusCode?: number }).statusCode);
    if (Number.isFinite(n) && n >= 400) return n;
  }
  return 401;
}

/* Background image-intelligence endpoint, polled by the client after the fast Tier-1 dossier
   shows (same pattern as /deep). State machine over ScanRun.normalizedResult (jsonb):
   1. first call → reverse-image search (Vision WEB_DETECTION) the LinkedIn photo; render a
      preliminary "Image intelligence" section AND start a DR synthesis job. 2. later calls →
      poll the synth job; on completion append its narrative; mark imageStatus="completed".
   Degrades to "completed" with a note when there's no photo / Vision isn't configured, so it
   can never break the dashboard. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const { id } = await context.params;
    if (!id) return NextResponse.json({ ok: false, error: "Missing scan id" }, { status: 400 });

    const scan = await getResearchJob(verified.uid, id);
    if (!scan) return NextResponse.json({ ok: false, status: "unknown", result: null }, { status: 404 });

    if (
      scan.status !== "completed" ||
      !scan.normalizedResult ||
      typeof scan.normalizedResult !== "object" ||
      Array.isArray(scan.normalizedResult)
    ) {
      return NextResponse.json({ ok: false, imageStatus: "pending", result: null });
    }

    const result = scan.normalizedResult as OneDashboardResult & Record<string, unknown>;
    if (result.imageStatus === "completed" || result.imageStatus === "failed") {
      return NextResponse.json({ ok: true, imageStatus: result.imageStatus, result });
    }

    const stored = (scan.input ?? {}) as Partial<OneSubjectInput>;
    const subject: OneSubjectInput = {
      name: stored.name || result.subject?.name || "",
      email: stored.email || result.subject?.email || "",
      latitude: stored.latitude,
      longitude: stored.longitude,
      zipCode: stored.zipCode,
      confirmedProfiles: stored.confirmedProfiles,
      linkedinProfile: stored.linkedinProfile,
      consentAttestation: true,
      purpose: "self_audit",
    };
    const pictureUrl = stored.linkedinProfile?.pictureUrl ?? null;

    // ── Stage 1: no synth job yet and nothing rendered → run reverse image search. ──
    if (!result.imageJobId && !result.imageReport) {
      if (!pictureUrl || !visionConfigured()) {
        const note = !pictureUrl
          ? "## Image intelligence\n\n_No verified profile photo was available for reverse image search._"
          : "## Image intelligence\n\n_Reverse image search isn't configured for this environment._";
        const merged = await updateDeepTier(verified.uid, id, { imageStatus: "completed", imageReport: note, imageJobId: null });
        return NextResponse.json({ ok: true, imageStatus: "completed", result: merged ?? result });
      }

      const wd = await runWebDetection(pictureUrl);
      if (!wd || !hasSignal(wd)) {
        const note = "## Image intelligence\n\n_No cross-web matches were found for the profile photo._";
        const merged = await updateDeepTier(verified.uid, id, { imageStatus: "completed", imageReport: note, imageJobId: null });
        return NextResponse.json({ ok: true, imageStatus: "completed", result: merged ?? result });
      }

      const summary = renderWebDetection(wd);
      let jobId: string | null = null;
      try {
        ({ jobId } = await startResearch(buildImageBatchQuestion(subject, wd), imageDepth()));
      } catch {
        // Synthesis couldn't start → still surface the raw reverse-image findings.
        const merged = await updateDeepTier(verified.uid, id, { imageStatus: "completed", imageReport: summary, imageJobId: null });
        return NextResponse.json({ ok: true, imageStatus: "completed", result: merged ?? result });
      }
      const merged = await updateDeepTier(verified.uid, id, {
        imageStatus: "running",
        imageReport: summary,
        imageJobId: jobId,
        imageStartedAt: Date.now(),
      });
      return NextResponse.json({ ok: true, imageStatus: "running", result: merged ?? result });
    }

    // ── Stage 2: a synth job is in flight → poll it. ──
    if (result.imageJobId) {
      if (typeof result.imageStartedAt === "number" && Date.now() - result.imageStartedAt > IMAGE_STALE_MS) {
        console.info(
          JSON.stringify({ event: "one.research.image_stale_timeout", severity: "WARNING", scanRunId: id, elapsedMs: Date.now() - result.imageStartedAt }),
        );
        const merged = await updateDeepTier(verified.uid, id, { imageStatus: "completed", imageJobId: null, imageStartedAt: undefined });
        return NextResponse.json({ ok: true, imageStatus: "completed", result: merged ?? result });
      }
      let dr;
      try {
        dr = await pollResearch(result.imageJobId, { fast: true });
      } catch {
        return NextResponse.json({ ok: true, imageStatus: "running", result });
      }
      if (dr.status === "completed" && dr.report) {
        if (advancing.has(id)) return NextResponse.json({ ok: true, imageStatus: "running", result });
        advancing.add(id);
        try {
          const fresh = await getResearchJob(verified.uid, id);
          const fr = (fresh?.normalizedResult ?? result) as OneDashboardResult & Record<string, unknown>;
          if (fr.imageStatus === "completed" || !fr.imageJobId) {
            return NextResponse.json({ ok: true, imageStatus: fr.imageStatus ?? "completed", result: fr });
          }
          const appended = `${fr.imageReport ? `${fr.imageReport}\n\n` : ""}${dr.report.trim()}`.trim();
          const citations = [
            ...(Array.isArray(fr.imageCitations) ? fr.imageCitations : []),
            ...(Array.isArray(dr.citations) ? dr.citations : []),
          ];
          const merged = await updateDeepTier(verified.uid, id, {
            imageReport: appended,
            imageCitations: citations,
            imageJobId: null,
            imageStartedAt: undefined,
            imageStatus: "completed",
          });
          return NextResponse.json({ ok: true, imageStatus: "completed", result: merged ?? fr });
        } finally {
          advancing.delete(id);
        }
      }
      if (dr.status === "failed") {
        // Keep the raw reverse-image summary we already stored; just close out.
        const merged = await updateDeepTier(verified.uid, id, { imageStatus: "completed", imageJobId: null, imageStartedAt: undefined });
        return NextResponse.json({ ok: true, imageStatus: "completed", result: merged ?? result });
      }
      return NextResponse.json({ ok: true, imageStatus: "running", result });
    }

    // imageReport exists but no job and not terminal → close it out.
    const merged = await updateDeepTier(verified.uid, id, { imageStatus: "completed", imageJobId: null });
    return NextResponse.json({ ok: true, imageStatus: "completed", result: merged ?? result });
  } catch (error) {
    const status = statusCodeOf(error);
    const message = error instanceof Error ? error.message : "Could not advance the image tier";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
