import { describe, expect, it } from "vitest";
import { oneVoiceProgress, oneVoiceScanningAt } from "./progress";

describe("oneVoiceProgress", () => {
  it("maps real DR progress signals to One-voiced lines", () => {
    expect(oneVoiceProgress("Reviewing the subject's LinkedIn profile", 0)).toBe("One is reading LinkedIn…");
    expect(oneVoiceProgress("Found a GitHub repository with contributions", 0)).toBe("One is reading code & projects…");
    expect(oneVoiceProgress("Cross-checking conflicting employment claims", 1)).toBe("One is cross-checking sources…");
    expect(oneVoiceProgress("Searching the web and grounding queries", 0)).toBe("One is searching the public web…");
    expect(oneVoiceProgress("Reading a news article from a press release", 0)).toBe("One is reading news & media…");
    expect(oneVoiceProgress("Checking public government registry records", 0)).toBe("One is checking public records…");
    expect(oneVoiceProgress("Now composing the final report", 5)).toBe("One is composing your report…");
  });

  it("surfaces a clean domain when present", () => {
    expect(oneVoiceProgress("Reading https://acme-corp.io/team for context", 0)).toBe("One is reading acme-corp.io…");
  });

  it("falls back to the phase line when there is no signal", () => {
    expect(oneVoiceProgress(null, 0)).toBe("One is searching the public web…");
    expect(oneVoiceProgress("", 5)).toBe("One is composing your report…");
    expect(oneVoiceProgress("blah blah unrelated text", 1)).toBe("One is reading what it finds…");
  });

  it("always starts with 'One is' and ends with an ellipsis", () => {
    for (const raw of [null, "linkedin", "random noise", "composing"]) {
      const out = oneVoiceProgress(raw as string | null, 2);
      expect(out.startsWith("One is ")).toBe(true);
      expect(out.endsWith("…")).toBe(true);
    }
  });
});

describe("oneVoiceScanningAt", () => {
  it("returns a One-voiced source line", () => {
    const out = oneVoiceScanningAt(0);
    expect(out.startsWith("One is checking ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});
