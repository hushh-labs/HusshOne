import { describe, expect, it } from "vitest";
import {
  buildSynthesisContext,
  buildSynthesisRequest,
  parseSynthesisResponse,
  PREFERENCE_SYNTH_SCHEMA,
  type MediaAnalysisRecord,
} from "./preference-synthesis";
import { PREFERENCE_QUESTIONS, type PreferenceQuestionDefinition } from "./preference-profile";
import type { ArchiveContentRecord } from "@/lib/db/scan-store";

function content(partial: Partial<ArchiveContentRecord>): ArchiveContentRecord {
  return {
    platform: "instagram",
    publicId: "u",
    itemId: "i1",
    itemUrl: "https://x/p/1",
    itemType: "post",
    text: "hello",
    timestamp: null,
    media: null,
    metrics: null,
    ...partial,
  };
}

function media(analysis: unknown): MediaAnalysisRecord {
  return { platform: "instagram", assetHash: "h", sourceUrl: "https://cdn/x.jpg", analysis };
}

describe("buildSynthesisContext", () => {
  it("aggregates media brands/logos/colors by frequency and collects text snippets", () => {
    const ctx = buildSynthesisContext(
      [content({ itemId: "a", text: "Loving the new Pixel" }), content({ itemId: "b", platform: "x", itemType: "tweet", text: "coffee run" })],
      [
        media({ status: "completed", vision: { logos: ["Google"], ocrText: "Made by Google" }, semantic: { brands: ["Google", "Pixel"], colorAesthetic: ["blue"], scene: "office" } }),
        media({ status: "completed", vision: { logos: ["Google"] }, semantic: { brands: ["Google"], colorAesthetic: ["blue", "white"] } }),
        media({ status: "pending" }), // ignored
      ],
    );
    expect(ctx.platforms).toEqual(["instagram", "x"]);
    expect(ctx.contentItemCount).toBe(2);
    expect(ctx.mediaAnalyzedCount).toBe(2);
    expect(ctx.mediaSignals.brands[0].toLowerCase()).toBe("google"); // most frequent first
    expect(ctx.mediaSignals.logos).toContain("Google");
    expect(ctx.mediaSignals.colorAesthetic).toEqual(expect.arrayContaining(["blue", "white"]));
    expect(ctx.textSnippets.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("buildSynthesisRequest", () => {
  it("forces JSON output with the answers schema and embeds questions + evidence", () => {
    const ctx = buildSynthesisContext([content({})], []);
    const { model, body } = buildSynthesisRequest("gemini-3.1-pro", ctx, PREFERENCE_QUESTIONS.slice(0, 2), "COO at Foo");
    expect(model).toBe("gemini-3.1-pro");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBe(PREFERENCE_SYNTH_SCHEMA);
    const text = body.contents[0].parts[0].text;
    expect(text).toContain("QUESTIONS:");
    expect(text).toContain(PREFERENCE_QUESTIONS[0].id);
    expect(text).toContain("COO at Foo");
    expect(text).toContain("30 preference questions");
  });
});

describe("parseSynthesisResponse", () => {
  const wrap = (answers: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answers }) }] } }] });

  it("maps answers and fills every missing question with an honest unknown", () => {
    const q = PREFERENCE_QUESTIONS[0];
    const answers = parseSynthesisResponse(
      wrap([{ questionId: q.id, status: "answered", answer: "Quiet luxury", confidence: "high", source: "observed", evidenceIds: ["a"] }]),
      PREFERENCE_QUESTIONS,
    );
    expect(answers).toHaveLength(PREFERENCE_QUESTIONS.length);
    const first = answers.find((a) => a.questionId === q.id)!;
    expect(first).toMatchObject({ status: "answered", answer: "Quiet luxury", confidence: "high", evidenceIds: ["a"] });
    // every other question defaulted to unknown/null
    const others = answers.filter((a) => a.questionId !== q.id);
    expect(others.every((a) => a.status === "unknown" && a.answer === null)).toBe(true);
  });

  it("ENFORCES the sensitive guardrail: a sensitive question can't be asserted without self-declaration", () => {
    const sensitive = PREFERENCE_QUESTIONS.find((x) => x.sensitive) as PreferenceQuestionDefinition;
    expect(sensitive).toBeTruthy();
    // model tries to assert an inferred romantic trait from observed evidence → downgraded
    const answers = parseSynthesisResponse(
      wrap([{ questionId: sensitive.id, status: "inferred", answer: "Prefers grand gestures", confidence: "high", source: "observed" }]),
      PREFERENCE_QUESTIONS,
    );
    const a = answers.find((x) => x.questionId === sensitive.id)!;
    expect(a.status).toBe("needs_confirmation");
    expect(a.needsUserConfirmation).toBe(true);
  });

  it("allows a sensitive answer only when the user self-declared it", () => {
    const sensitive = PREFERENCE_QUESTIONS.find((x) => x.sensitive) as PreferenceQuestionDefinition;
    const answers = parseSynthesisResponse(
      wrap([{ questionId: sensitive.id, status: "answered", answer: "Loves cooking together", confidence: "medium", source: "self_declared", evidenceIds: ["p1"] }]),
      PREFERENCE_QUESTIONS,
    );
    const a = answers.find((x) => x.questionId === sensitive.id)!;
    expect(a.status).toBe("answered");
    expect(a.source).toBe("self_declared");
  });

  it("tolerates malformed model output (all unknown)", () => {
    const answers = parseSynthesisResponse({}, PREFERENCE_QUESTIONS);
    expect(answers).toHaveLength(PREFERENCE_QUESTIONS.length);
    expect(answers.every((a) => a.status === "unknown")).toBe(true);
  });
});
