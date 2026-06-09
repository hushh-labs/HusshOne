/* Phase 2 orchestration: take the raw Gemini phase-1 dossier, refine it via the
   DR API's Claude (Opus) synthesis — disambiguated + confidence-ranked — and map it
   into the dashboard result shape. The synthesized report is the FINAL one shown.
   Fail-safe: on any synthesis error, fall back to the raw report so a scan never breaks. */
import { synthesizeReport, type SynthIdentity } from "./client";
import { mapResearchResult } from "./dossier";
import type { LocationMode, OneDashboardResult, OneSubjectInput } from "@/lib/ria/types";

function synthEnabled(): boolean {
  return process.env.ONE_RESEARCH_SYNTH !== "false";
}

function locationLabel(input: OneSubjectInput): string | undefined {
  if (typeof input.latitude === "number" && typeof input.longitude === "number") {
    return `lat ${input.latitude.toFixed(3)}, lon ${input.longitude.toFixed(3)}`;
  }
  return input.zipCode || undefined;
}

export interface FinalizeOutcome {
  result: OneDashboardResult;
  phase2Ms: number; // wall time spent in Phase-2 (Opus synthesis); 0 when synth is disabled
}

export async function finalizeResearch(
  rawReport: string,
  citations: unknown[],
  input: OneSubjectInput,
  mode: LocationMode,
  scanRunId: string | null,
): Promise<FinalizeOutcome> {
  let finalReport = rawReport;
  let phase2Ms = 0;
  if (synthEnabled()) {
    const identity: SynthIdentity = {
      name: input.name,
      email: input.email,
      phone: input.phone,
      location: locationLabel(input),
      // Phase-0 anchors → Phase-2 so Claude disambiguates/structures around the real person.
      confirmedProfiles: input.confirmedProfiles,
    };
    const synthStart = Date.now();
    try {
      finalReport = await synthesizeReport(rawReport, identity, citations);
      phase2Ms = Date.now() - synthStart;
      console.info(JSON.stringify({ event: "one.research.synth_ok", severity: "INFO", scanRunId, phase2Ms }));
    } catch (error) {
      phase2Ms = Date.now() - synthStart;
      console.error(
        JSON.stringify({
          event: "one.research.synth_failed",
          severity: "ERROR",
          scanRunId,
          phase2Ms,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      finalReport = rawReport; // fail-safe: show the raw dossier rather than failing
    }
  }
  const result = mapResearchResult(finalReport, citations, input, mode, scanRunId, rawReport);
  return { result, phase2Ms };
}
