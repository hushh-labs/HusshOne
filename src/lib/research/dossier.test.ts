import { describe, expect, it } from "vitest";
import { buildPersonDossierQuestion, mapResearchResult } from "./dossier";
import { INTELLIGENCE_VERSION } from "./version";
import type { ConfirmedProfile, OneSubjectInput } from "@/lib/ria/types";

function baseInput(confirmedProfiles?: ConfirmedProfile[]): OneSubjectInput {
  return {
    name: "Ankit Singh",
    email: "ankit@example.com",
    latitude: 18.52,
    longitude: 73.85,
    confirmedProfiles,
    consentAttestation: true,
    purpose: "self_audit",
  };
}

describe("buildPersonDossierQuestion", () => {
  it("promotes a LinkedIn pivot to the PRIMARY ANCHOR spine", () => {
    const url = "https://www.linkedin.com/in/ankit-kumar-singh-001";
    const q = buildPersonDossierQuestion(
      baseInput([{ platform: "LinkedIn", handle: "ankit-kumar-singh-001", url, category: "Professional" }]),
    );
    expect(q).toContain("PRIMARY ANCHOR — LinkedIn");
    expect(q).toContain(url);
    // it must instruct deriving the search plan from the profile (the "strong Phase-1" bit)
    expect(q).toMatch(/DERIVE the entire search plan/i);
    // and must NOT fall back to the generic-only anchor heading
    expect(q).not.toContain("VERIFIED IDENTITY ANCHORS (subject-confirmed");
  });

  it("uses the generic anchor block when the only pivot is not LinkedIn", () => {
    const q = buildPersonDossierQuestion(
      baseInput([{ platform: "GitHub", handle: "ankit", url: "https://github.com/ankit", category: "Dev/code" }]),
    );
    expect(q).toContain("VERIFIED IDENTITY ANCHORS");
    expect(q).not.toContain("PRIMARY ANCHOR — LinkedIn");
  });

  it("omits any anchor block when no profiles are confirmed", () => {
    const q = buildPersonDossierQuestion(baseInput());
    expect(q).not.toContain("PRIMARY ANCHOR");
    expect(q).not.toContain("VERIFIED IDENTITY ANCHORS");
  });
});

describe("mapResearchResult", () => {
  it("stamps the current intelligence version onto the result", () => {
    const result = mapResearchResult("# Report\n\nSome body text long enough to summarize.", [], baseInput(), "precise", "scan-1");
    expect(result.intelligenceVersion).toBe(INTELLIGENCE_VERSION);
    expect(result.source).toBe("deep_research");
  });
});
