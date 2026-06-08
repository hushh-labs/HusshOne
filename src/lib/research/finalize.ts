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

export async function finalizeResearch(
  rawReport: string,
  citations: unknown[],
  input: OneSubjectInput,
  mode: LocationMode,
  scanRunId: string | null,
): Promise<OneDashboardResult> {
  let finalReport = rawReport;
  if (synthEnabled()) {
    const identity: SynthIdentity = {
      name: input.name,
      email: input.email,
      phone: input.phone,
      location: locationLabel(input),
    };
    try {
      finalReport = await synthesizeReport(rawReport, identity, citations);
      console.info(JSON.stringify({ event: "one.research.synth_ok", severity: "INFO", scanRunId }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "one.research.synth_failed",
          severity: "ERROR",
          scanRunId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      finalReport = rawReport; // fail-safe: show the raw dossier rather than failing
    }
  }
  return mapResearchResult(finalReport, citations, input, mode, scanRunId, rawReport);
}
