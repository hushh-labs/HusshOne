import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSectionContext,
  buildSectionSynthesisRequest,
  buildSynthesisRequest,
  countAnalyzedMedia,
  parseSectionAnswers,
  parseSynthesisResponse,
  synthesizePreferences,
  toRenderablePreferenceProfile,
  buildPreferenceCollage,
  SECTION_EVIDENCE,
  PREFERENCE_SYNTH_SCHEMA,
  PREFERENCE_SYNTHESIS_VERSION,
  type MediaAnalysisRecord,
  type PreferenceSynthesisResult,
} from "./preference-synthesis";
import {
  PREFERENCE_QUESTIONS,
  type PreferenceQuestionDefinition,
  type PreferenceQuestionSectionId,
} from "./preference-profile";
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

function media(analysis: unknown, assetHash = "h"): MediaAnalysisRecord {
  return { platform: "instagram", assetHash, sourceUrl: "https://cdn/x.jpg", analysis };
}

const wrap = (answers: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answers }) }] } }] });

const SECTION_OF = (sectionId: PreferenceQuestionSectionId) => PREFERENCE_QUESTIONS.filter((q) => q.sectionId === sectionId);

/* ── buildSectionContext: targeted, per-section evidence ──────────────────────────────────────── */

describe("buildSectionContext", () => {
  it("routes style media signals (brands/logos/colors/clothing) with frequency counts + asset hashes", () => {
    const ctx = buildSectionContext(
      "style_brands_color",
      [
        content({ itemId: "a", text: "Loving the new Pixel and this quiet luxury fit check" }),
        content({ itemId: "b", platform: "x", itemType: "tweet", text: "random unrelated thought" }),
      ],
      [
        media({ status: "completed", vision: { logos: ["Google"], dominantColors: ["blue"] }, semantic: { brands: ["Google", "Pixel"], colorAesthetic: ["blue"], clothingStyle: ["minimal"] } }, "h1"),
        media({ status: "completed", vision: { logos: ["Google"], dominantColors: ["blue", "white"] }, semantic: { brands: ["Google"], colorAesthetic: ["blue"] } }, "h2"),
        media({ status: "pending" }, "h3"), // ignored
      ],
    );
    expect(ctx.sectionId).toBe("style_brands_color");
    expect(ctx.platforms).toEqual(["instagram", "x"]);
    expect(ctx.mediaAnalyzedCount).toBe(2);
    const brands = ctx.mediaSignals.find((s) => s.label === "brands")!;
    expect(brands.values[0].value.toLowerCase()).toBe("google"); // most frequent first
    expect(brands.values[0].count).toBe(2);
    expect(ctx.mediaSignals.find((s) => s.label === "logos")).toBeTruthy();
    expect(ctx.mediaSignals.find((s) => s.label === "dominantColors")).toBeTruthy();
    // keyword-relevant snippet ("quiet luxury fit check") is ordered before the unrelated one
    expect(ctx.textSnippets[0].id).toBe("a");
    // representative asset hashes are carried through for media citations
    expect(ctx.mediaAssetHashes).toEqual(expect.arrayContaining(["h1", "h2"]));
  });

  it("reads NEW optional semantic fields (cuisineCategory/venueType) for food without crashing when absent", () => {
    const ctx = buildSectionContext(
      "food_culinary",
      [content({ itemId: "f1", text: "best ramen in the city" })],
      [
        media({ status: "completed", semantic: { foodDrink: ["ramen"], cuisineCategory: "Japanese", venueType: "restaurant" } }, "m1"),
        media({ status: "completed", semantic: { foodDrink: ["coffee"] } }, "m2"), // missing new fields → defensive
      ],
    );
    expect(ctx.mediaSignals.find((s) => s.label === "cuisineCategory")?.values[0].value).toBe("Japanese");
    expect(ctx.mediaSignals.find((s) => s.label === "venueType")?.values[0].value).toBe("restaurant");
    expect(ctx.mediaSignals.find((s) => s.label === "foodDrink")).toBeTruthy();
  });

  it("partner_romance is TEXT ONLY: never surfaces media signals or asset hashes", () => {
    const ctx = buildSectionContext(
      "partner_romance",
      [content({ itemId: "p1", text: "spent the weekend with my partner" })],
      [media({ status: "completed", semantic: { scene: "restaurant", socialSetting: "couple" } }, "mz")],
    );
    expect(ctx.mediaSignals).toEqual([]);
    expect(ctx.mediaAssetHashes).toEqual([]);
    // but it still counts analyzed media for context + keeps the relevant text snippet
    expect(ctx.mediaAnalyzedCount).toBe(1);
    expect(ctx.textSnippets[0].id).toBe("p1");
    expect(SECTION_EVIDENCE.partner_romance.textOnly).toBe(true);
  });
});

describe("countAnalyzedMedia", () => {
  it("counts only completed analyses", () => {
    expect(countAnalyzedMedia([media({ status: "completed" }), media({ status: "pending" }), media({ status: "completed" })])).toBe(2);
  });
});

/* ── request builders ─────────────────────────────────────────────────────────────────────────── */

describe("buildSectionSynthesisRequest", () => {
  it("forces JSON output with the answer-required schema and embeds the section's questions + evidence", () => {
    const ctx = buildSectionContext("style_brands_color", [content({})], []);
    const sectionQs = SECTION_OF("style_brands_color");
    const { model, body } = buildSectionSynthesisRequest("gemini-2.5-pro", ctx, sectionQs, "COO at Foo");
    expect(model).toBe("gemini-2.5-pro");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBe(PREFERENCE_SYNTH_SCHEMA);
    // schema now REQUIRES answer
    expect(PREFERENCE_SYNTH_SCHEMA.properties.answers.items.required).toContain("answer");
    const text = body.contents[0].parts[0].text;
    expect(text).toContain("SECTION: style_brands_color");
    expect(text).toContain(sectionQs[0].id);
    expect(text).toContain("COO at Foo");
    // reframed instruction: calibrated inference, not "prefer unknown"
    expect(text).toContain("calibrated confidence");
    expect(text).not.toContain("Prefer \"unknown\" over guessing");
  });
});

describe("buildSynthesisRequest (back-compat combined builder)", () => {
  it("still builds a JSON request over all questions", () => {
    const ctx = buildSectionContext("style_brands_color", [content({})], []);
    const { body } = buildSynthesisRequest("gemini-2.5-pro", ctx, PREFERENCE_QUESTIONS.slice(0, 2), "COO at Foo");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    const text = body.contents[0].parts[0].text;
    expect(text).toContain("QUESTIONS:");
    expect(text).toContain(PREFERENCE_QUESTIONS[0].id);
  });
});

/* ── parse: reframed (keep answer on low confidence) + sensitive guardrail ────────────────────── */

describe("parseSectionAnswers", () => {
  it("keeps the model's answer even at low confidence (does NOT null it)", () => {
    const styleQs = SECTION_OF("style_brands_color");
    const q = styleQs[0];
    const answers = parseSectionAnswers(
      wrap([{ questionId: q.id, status: "inferred", answer: "Leans minimal monochrome", confidence: "low", source: "aggregate", evidenceIds: ["a"], mediaEvidenceIds: ["h1"] }]),
      styleQs,
    );
    const first = answers.find((a) => a.questionId === q.id)!;
    expect(first.status).toBe("inferred");
    expect(first.answer).toBe("Leans minimal monochrome"); // kept despite low confidence
    expect(first.confidence).toBe("low");
    expect(first.mediaEvidenceIds).toEqual(["h1"]);
  });

  it("promotes a stray status:unknown WITH an answer to inferred (don't discard real signal)", () => {
    const styleQs = SECTION_OF("style_brands_color");
    const q = styleQs[0];
    const answers = parseSectionAnswers(
      wrap([{ questionId: q.id, status: "unknown", answer: "Probably blue", confidence: "low", source: "inferred" }]),
      styleQs,
    );
    const a = answers.find((x) => x.questionId === q.id)!;
    expect(a.status).toBe("inferred");
    expect(a.answer).toBe("Probably blue");
  });

  it("sets status unknown (answer null) only when there is genuinely no answer", () => {
    const styleQs = SECTION_OF("style_brands_color");
    const q = styleQs[0];
    const answers = parseSectionAnswers(
      wrap([{ questionId: q.id, status: "inferred", answer: "", confidence: "low" }]),
      styleQs,
    );
    const a = answers.find((x) => x.questionId === q.id)!;
    expect(a.status).toBe("unknown");
    expect(a.answer).toBeNull();
  });

  it("fills questions the model omitted with honest unknowns", () => {
    const styleQs = SECTION_OF("style_brands_color");
    const answers = parseSectionAnswers(wrap([]), styleQs);
    expect(answers).toHaveLength(styleQs.length);
    expect(answers.every((a) => a.status === "unknown" && a.answer === null)).toBe(true);
  });

  it("ENFORCES the sensitive guardrail: a sensitive answer can't be asserted without self-declaration", () => {
    const sensitiveQs = SECTION_OF("partner_romance");
    const sensitive = sensitiveQs.find((x) => x.sensitive) as PreferenceQuestionDefinition;
    expect(sensitive).toBeTruthy();
    const answers = parseSectionAnswers(
      wrap([{ questionId: sensitive.id, status: "inferred", answer: "Prefers grand gestures", confidence: "high", source: "observed" }]),
      sensitiveQs,
    );
    const a = answers.find((x) => x.questionId === sensitive.id)!;
    expect(a.status).toBe("needs_confirmation");
    expect(a.needsUserConfirmation).toBe(true);
  });

  it("allows a sensitive answer only when the user self-declared it", () => {
    const sensitiveQs = SECTION_OF("partner_romance");
    const sensitive = sensitiveQs.find((x) => x.sensitive) as PreferenceQuestionDefinition;
    const answers = parseSectionAnswers(
      wrap([{ questionId: sensitive.id, status: "answered", answer: "Loves cooking together", confidence: "medium", source: "self_declared", evidenceIds: ["p1"] }]),
      sensitiveQs,
    );
    const a = answers.find((x) => x.questionId === sensitive.id)!;
    expect(a.status).toBe("answered");
    expect(a.source).toBe("self_declared");
  });
});

describe("parseSynthesisResponse (full-set back-compat)", () => {
  it("maps answers and fills every missing question with an honest unknown", () => {
    const q = PREFERENCE_QUESTIONS[0];
    const answers = parseSynthesisResponse(
      wrap([{ questionId: q.id, status: "answered", answer: "Quiet luxury", confidence: "high", source: "observed", evidenceIds: ["a"] }]),
      PREFERENCE_QUESTIONS,
    );
    expect(answers).toHaveLength(PREFERENCE_QUESTIONS.length);
    const first = answers.find((a) => a.questionId === q.id)!;
    expect(first).toMatchObject({ status: "answered", answer: "Quiet luxury", confidence: "high", evidenceIds: ["a"] });
    const others = answers.filter((a) => a.questionId !== q.id);
    expect(others.every((a) => a.status === "unknown" && a.answer === null)).toBe(true);
  });

  it("tolerates malformed model output (all unknown)", () => {
    const answers = parseSynthesisResponse({}, PREFERENCE_QUESTIONS);
    expect(answers).toHaveLength(PREFERENCE_QUESTIONS.length);
    expect(answers.every((a) => a.status === "unknown")).toBe(true);
  });
});

/* ── synthesizePreferences: per-section parallel synthesis (mocked Vertex) ────────────────────── */

describe("synthesizePreferences (per-section, mocked Vertex)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.VERTEX_PROJECT = "test-project";
    process.env.VERTEX_LOCATION = "us-central1";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  /** Stub global fetch: metadata token endpoint → a fake token; Vertex generateContent → an answers
   *  payload built by `answersFor(sectionId)`. Records which sections were called. */
  function stubVertex(answersFor: (sectionId: string) => unknown[]) {
    const calledSections: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("metadata.google.internal")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) } as Response;
        }
        // Vertex generateContent — read the section out of the prompt we sent.
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const text: string = body?.contents?.[0]?.parts?.[0]?.text ?? "";
        const match = text.match(/SECTION: (\w+)/);
        const sectionId = match?.[1] ?? "unknown";
        calledSections.push(sectionId);
        return { ok: true, json: async () => wrap(answersFor(sectionId)) } as Response;
      }),
    );
    return calledSections;
  }

  it("runs one call PER SECTION (6) and merges into 30 answers", async () => {
    const calledSections = stubVertex((sectionId) =>
      SECTION_OF(sectionId as PreferenceQuestionSectionId).map((q) => ({
        questionId: q.id,
        status: q.sensitive ? "needs_confirmation" : "inferred",
        answer: `read for ${q.id}`,
        confidence: "low",
        source: q.sensitive ? "not_available" : "aggregate",
      })),
    );

    const result = await synthesizePreferences({
      contentItems: [content({ itemId: "a", text: "coffee and quiet luxury fits" })],
      mediaAnalyses: [media({ status: "completed", semantic: { brands: ["Google"], foodDrink: ["coffee"] } }, "h1")],
    });

    expect(result).not.toBeNull();
    const r = result as PreferenceSynthesisResult;
    expect(r.answers).toHaveLength(PREFERENCE_QUESTIONS.length); // 30
    // all 6 sections were each called exactly once
    expect(new Set(calledSections).size).toBe(6);
    expect(calledSections).toHaveLength(6);
    // non-sensitive answers were kept (calibrated inference)
    const style = r.answers.find((a) => a.sectionId === "style_brands_color")!;
    expect(style.status).toBe("inferred");
    expect(style.answer).toContain("read for");
    // sensitive section downgraded
    const romance = r.answers.find((a) => a.sectionId === "partner_romance")!;
    expect(["needs_confirmation", "unknown"]).toContain(romance.status);
    expect(r.model).toBe("gemini-2.5-pro");
    expect(r.version).toBe(PREFERENCE_SYNTHESIS_VERSION);
  });

  it("questions-subset path: only the involved sections are called, only those answers returned", async () => {
    const subset = SECTION_OF("food_culinary"); // 5 questions, one section
    const calledSections = stubVertex((sectionId) =>
      SECTION_OF(sectionId as PreferenceQuestionSectionId).map((q) => ({
        questionId: q.id,
        status: "inferred",
        answer: `food read ${q.id}`,
        confidence: "medium",
        source: "aggregate",
      })),
    );

    const result = await synthesizePreferences({
      contentItems: [content({ itemId: "f", text: "ramen night" })],
      mediaAnalyses: [media({ status: "completed", semantic: { foodDrink: ["ramen"] } })],
      questions: subset,
    });

    const r = result as PreferenceSynthesisResult;
    expect(r.answers).toHaveLength(subset.length); // only the subset
    expect(r.answers.every((a) => a.sectionId === "food_culinary")).toBe(true);
    expect(calledSections).toEqual(["food_culinary"]); // only one section called
  });

  it("returns null only when EVERY section call fails (Vertex unavailable) so caller keeps fast pass", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("metadata.google.internal")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response; // every Vertex call fails
      }),
    );
    const result = await synthesizePreferences({
      contentItems: [content({})],
      mediaAnalyses: [],
    });
    expect(result).toBeNull();
  });

  it("partial failure: succeeded sections keep answers, failed sections fall back to unknowns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("metadata.google.internal")) {
          return { ok: true, json: async () => ({ access_token: "tok" }) } as Response;
        }
        const text: string = init?.body ? JSON.parse(init.body as string)?.contents?.[0]?.parts?.[0]?.text ?? "" : "";
        const sectionId = text.match(/SECTION: (\w+)/)?.[1] ?? "";
        if (sectionId === "food_culinary") {
          return {
            ok: true,
            json: async () =>
              wrap(SECTION_OF("food_culinary").map((q) => ({ questionId: q.id, status: "inferred", answer: `ok ${q.id}`, confidence: "low", source: "aggregate" }))),
          } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response; // all other sections fail
      }),
    );

    const result = await synthesizePreferences({ contentItems: [content({ text: "ramen" })], mediaAnalyses: [] });
    const r = result as PreferenceSynthesisResult;
    expect(r).not.toBeNull();
    expect(r.answers).toHaveLength(PREFERENCE_QUESTIONS.length);
    expect(r.answers.filter((a) => a.sectionId === "food_culinary").every((a) => a.status === "inferred")).toBe(true);
    expect(r.answers.filter((a) => a.sectionId === "travel_wanderlust").every((a) => a.status === "unknown")).toBe(true);
  });
});

/* ── render mapping (unchanged contract) ─────────────────────────────────────────────────────── */

describe("toRenderablePreferenceProfile", () => {
  it("maps the synthesis into the dashboard-renderable shape with coverage, sections, and depth", () => {
    const answers = parseSynthesisResponse(
      wrap([{ questionId: PREFERENCE_QUESTIONS[0].id, status: "answered", answer: "Quiet luxury", confidence: "high", source: "observed", evidenceIds: ["a"], mediaEvidenceIds: ["m1"] }]),
      PREFERENCE_QUESTIONS,
    );
    const result: PreferenceSynthesisResult = {
      version: PREFERENCE_SYNTHESIS_VERSION,
      model: "gemini-2.5-pro",
      answers,
      context: { platforms: ["instagram"], contentItems: 684, mediaAnalyzed: 512 },
    };
    const depth = {
      perPlatform: { instagram: { items: 684, mediaTotal: 684, mediaAnalyzed: 512, mediaPending: 172, mediaFailed: 0 } },
      totals: { items: 684, mediaTotal: 684, mediaAnalyzed: 512, mediaPending: 172 },
    };
    const renderable = toRenderablePreferenceProfile(result, depth, { generatedAt: "2026-06-18T00:00:00Z", preferenceStatus: "partial" });

    expect(renderable.questionAnswers).toHaveLength(PREFERENCE_QUESTIONS.length);
    expect(renderable.questionCoverage.total).toBe(PREFERENCE_QUESTIONS.length);
    expect(renderable.questionCoverage.answered).toBe(1);
    expect(renderable.sectionSummaries.length).toBeGreaterThanOrEqual(6);
    const first = renderable.questionAnswers.find((a) => a.questionId === PREFERENCE_QUESTIONS[0].id) as Record<string, unknown>;
    expect((first.confidence as { level: string }).level).toBe("high");
    expect(first.updatedFrom).toBe("media_pass");
    expect(renderable.archiveDepth).toBe(depth);
    expect(renderable.preferenceStatus).toBe("partial");
    expect(renderable.summary).toContain("read on");
    expect(renderable.summary).toContain("your taste");
  });
});

describe("buildPreferenceCollage", () => {
  const item = (itemId: string, primaryUrl: string | null, text = "cap") => ({
    platform: "instagram",
    publicId: "u",
    itemId,
    itemUrl: `https://insta/p/${itemId}`,
    itemType: "post",
    text,
    timestamp: null,
    media: primaryUrl ? { primaryUrl, urls: [primaryUrl], assetHashes: ["h"] } : null,
    metrics: null,
  });

  it("builds collage tiles from post media, deduped, capped, newest-first order preserved", () => {
    const items = [
      item("a", "https://cdn/a.jpg", "beach day"),
      item("b", null), // no media → skipped
      item("c", "https://cdn/a.jpg"), // duplicate image → skipped
      item("d", "https://cdn/d.jpg"),
    ];
    const collage = buildPreferenceCollage(items, 24);
    expect(collage.map((c) => c.imageUrl)).toEqual(["https://cdn/a.jpg", "https://cdn/d.jpg"]);
    expect(collage[0]).toMatchObject({ evidenceId: "a", postUrl: "https://insta/p/a", caption: "beach day", platform: "instagram" });
  });

  it("respects the limit and tolerates missing/blank media", () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`x${i}`, `https://cdn/x${i}.jpg`));
    expect(buildPreferenceCollage(items, 24)).toHaveLength(24);
    expect(buildPreferenceCollage([item("z", null)], 24)).toEqual([]);
  });
});
