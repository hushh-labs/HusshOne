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
  it("defuses a LinkedIn anchor into a load-reducer (identity pre-confirmed, budgeted, lean)", () => {
    const url = "https://www.linkedin.com/in/ankit-kumar-singh-001";
    const q = buildPersonDossierQuestion(
      baseInput([{ platform: "LinkedIn", handle: "ankit-kumar-singh-001", url, category: "Professional" }]),
    );
    expect(q).toContain("IDENTITY IS ALREADY CONFIRMED");
    expect(q).toContain(url);
    // explicit search budget bounds the agent's runtime
    expect(q).toMatch(/8.{0,3}12 targeted web searches/);
    // heavy derived sections that ballooned search work were cut
    expect(q).not.toContain("Net Worth Signal Score");
    expect(q).not.toContain("Breach Exposure");
    expect(q).not.toContain("SUBJECT — resolve identity");
  });

  it("falls back to name+email anchoring when the only pivot is not LinkedIn", () => {
    const q = buildPersonDossierQuestion(
      baseInput([{ platform: "GitHub", handle: "ankit", url: "https://github.com/ankit", category: "Dev/code" }]),
    );
    expect(q).toContain("SUBJECT — resolve identity");
    expect(q).toContain("https://github.com/ankit");
    expect(q).not.toContain("IDENTITY IS ALREADY CONFIRMED");
  });

  it("uses the name+email block when no profiles are confirmed", () => {
    const q = buildPersonDossierQuestion(baseInput());
    expect(q).toContain("SUBJECT — resolve identity");
    expect(q).not.toContain("IDENTITY IS ALREADY CONFIRMED");
  });
});

describe("mapResearchResult", () => {
  it("stamps the current intelligence version onto the result", () => {
    const result = mapResearchResult("# Report\n\nSome body text long enough to summarize.", [], baseInput(), "precise", "scan-1");
    expect(result.intelligenceVersion).toBe(INTELLIGENCE_VERSION);
    expect(result.source).toBe("deep_research");
  });
});
