import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSectionContext,
  buildSectionSynthesisRequest,
  buildSynthesisRequest,
  countAnalyzedMedia,
  engagementScore,
  mergeAnswerPair,
  parseSectionAnswers,
  parseSynthesisResponse,
  synthesizePreferences,
  toRenderablePreferenceProfile,
  buildPreferenceCollage,
  aggregateLifestyleFacts,
  SECTION_EVIDENCE,
  PREFERENCE_SYNTH_SCHEMA,
  PREFERENCE_SYNTHESIS_VERSION,
  type MediaAnalysisRecord,
  type PreferenceSynthesisResult,
  type SynthesizedAnswer,
} from "./preference-synthesis";
import {
  PREFERENCE_QUESTIONS,
  type PreferenceQuestionDefinition,
  type PreferenceQuestionSectionId,
} from "./preference-profile";
import type { ArchiveContentRecord } from "@/lib/db/scan-store";
import { buildPreferenceSummary } from "./preference-presentation";

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
      "brand_look",
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
    expect(ctx.sectionId).toBe("brand_look");
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
      "food_drink",
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

  it("v5: flattens NESTED pixel fields (clothing/eyewear/footwear) into brand_look signals", () => {
    const ctx = buildSectionContext(
      "brand_look",
      [content({ itemId: "a", text: "fit check" })],
      [
        media(
          {
            status: "completed",
            semantic: {
              clothing: [{ type: "blazer", color: "navy", brand: "Zara" }, { type: "tee", color: "white" }],
              eyewear: { present: true, color: "black", style: "wayfarer" },
              footwear: { type: "sneakers", model: "Air Jordan 1" },
            },
          },
          "h1",
        ),
        media({ status: "completed", semantic: { eyewear: { present: false } } }, "h2"), // absent → no glasses signal
      ],
    );
    const clothing = ctx.mediaSignals.find((s) => s.label === "clothing")!;
    expect(clothing.values.map((v) => v.value)).toEqual(expect.arrayContaining(["navy blazer (Zara)", "white tee"]));
    const eyewear = ctx.mediaSignals.find((s) => s.label === "eyewear")!;
    expect(eyewear.values[0].value).toBe("glasses: black wayfarer");
    const footwear = ctx.mediaSignals.find((s) => s.label === "footwear")!;
    expect(footwear.values[0].value).toBe("sneakers (Air Jordan 1)");
  });

  it("v5: social_vibe flattens face count into a solo/group signal", () => {
    const ctx = buildSectionContext(
      "social_vibe",
      [content({ itemId: "s1", text: "with the squad" })],
      [
        media({ status: "completed", vision: { faces: { count: 4 } }, semantic: { socialSetting: "large_gathering", eventType: "party" } }, "g1"),
        media({ status: "completed", vision: { faces: { count: 1 } }, semantic: { socialSetting: "solo" } }, "g2"),
      ],
    );
    const people = ctx.mediaSignals.find((s) => s.label === "people")!;
    expect(people.values.map((v) => v.value)).toEqual(expect.arrayContaining(["4 people", "solo (1 person)"]));
    expect(ctx.mediaSignals.find((s) => s.label === "eventType")?.values[0].value).toBe("party");
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
    const ctx = buildSectionContext("brand_look", [content({})], []);
    const sectionQs = SECTION_OF("brand_look");
    const { model, body } = buildSectionSynthesisRequest("gemini-2.5-pro", ctx, sectionQs, "COO at Foo");
    expect(model).toBe("gemini-2.5-pro");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBe(PREFERENCE_SYNTH_SCHEMA);
    // schema now REQUIRES answer
    expect(PREFERENCE_SYNTH_SCHEMA.properties.answers.items.required).toContain("answer");
    const text = body.contents[0].parts[0].text;
    expect(text).toContain("SECTION: brand_look");
    expect(text).toContain(sectionQs[0].id);
    expect(text).toContain("COO at Foo");
    // reframed instruction: calibrated inference, not "prefer unknown"
    expect(text).toContain("calibrated confidence");
    expect(text).not.toContain("Prefer \"unknown\" over guessing");
  });

  it("MULTIMODAL: attaches the section's real images as fileData parts + lists them as [img:hash], with per-agent temperature", () => {
    const ctx = buildSectionContext(
      "brand_look",
      [content({ itemId: "a", text: "quiet luxury fit check" })],
      [media({ status: "completed", cacheUri: "gs://b/h1.jpg", cacheMime: "image/jpeg", vision: { logos: ["Google"] }, semantic: { brands: ["Google"], colorAesthetic: ["blue"] } }, "h1")],
    );
    expect(ctx.mediaImages).toEqual([{ assetHash: "h1", fileUri: "gs://b/h1.jpg", mimeType: "image/jpeg" }]);
    const { body } = buildSectionSynthesisRequest("gemini-2.5-pro", ctx, SECTION_OF("brand_look"), undefined, { agentIndex: 1 });
    const parts = body.contents[0].parts as Array<Record<string, unknown>>;
    expect((parts[0] as { text?: string }).text).toContain("[img:h1]");
    expect(parts.some((p) => (p.fileData as { fileUri?: string } | undefined)?.fileUri === "gs://b/h1.jpg")).toBe(true);
    expect(body.generationConfig.temperature).toBeCloseTo(0.6); // agentIndex 1 → 0.35 + 1*0.25
  });
});

describe("buildSynthesisRequest (back-compat combined builder)", () => {
  it("still builds a JSON request over all questions", () => {
    const ctx = buildSectionContext("brand_look", [content({})], []);
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
    const styleQs = SECTION_OF("brand_look");
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
    const styleQs = SECTION_OF("brand_look");
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
    const styleQs = SECTION_OF("brand_look");
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
    const styleQs = SECTION_OF("brand_look");
    const answers = parseSectionAnswers(wrap([]), styleQs);
    expect(answers).toHaveLength(styleQs.length);
    expect(answers.every((a) => a.status === "unknown" && a.answer === null)).toBe(true);
  });

  // v5 removed the Partner & Romance section, but the sensitive guardrail in mapOneAnswer is kept as
  // defensive code (so re-adding a sensitive question stays safe). Exercise it with a synthetic question.
  const sensitiveQ: PreferenceQuestionDefinition = {
    id: "synthetic_sensitive",
    sectionId: "social_vibe",
    sectionTitle: "Social & Vibe",
    category: "social_behavior",
    prompt: "A sensitive probe",
    sensitive: true,
  };

  it("ENFORCES the sensitive guardrail: a sensitive answer can't be asserted without self-declaration", () => {
    const answers = parseSectionAnswers(
      wrap([{ questionId: sensitiveQ.id, status: "inferred", answer: "Prefers grand gestures", confidence: "high", source: "observed" }]),
      [sensitiveQ],
    );
    const a = answers[0];
    expect(a.status).toBe("needs_confirmation");
    expect(a.needsUserConfirmation).toBe(true);
  });

  it("allows a sensitive answer only when the user self-declared it", () => {
    const answers = parseSectionAnswers(
      wrap([{ questionId: sensitiveQ.id, status: "answered", answer: "Loves cooking together", confidence: "medium", source: "self_declared", evidenceIds: ["p1"] }]),
      [sensitiveQ],
    );
    const a = answers[0];
    expect(a.status).toBe("answered");
    expect(a.source).toBe("self_declared");
  });
});

describe("parseSynthesisResponse (full-set back-compat)", () => {
  it("maps answers and fills every missing question with an honest unknown", () => {
    const q = PREFERENCE_QUESTIONS[0];
    const answers = parseSynthesisResponse(
      wrap([{ questionId: q.id, status: "answered", answer: "Quiet luxury", confidence: "high", source: "observed", evidenceIds: ["a", "b"] }]),
      PREFERENCE_QUESTIONS,
    );
    expect(answers).toHaveLength(PREFERENCE_QUESTIONS.length);
    const first = answers.find((a) => a.questionId === q.id)!;
    expect(first).toMatchObject({ status: "answered", answer: "Quiet luxury", confidence: "high", evidenceIds: ["a", "b"] });
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

  it("runs 4 agents PER SECTION (24 calls) and merges into 30 answers", async () => {
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
    // all 6 sections were covered, each read by 4 independent agents (24 calls) then merged
    expect(new Set(calledSections).size).toBe(6);
    expect(calledSections).toHaveLength(24);
    // non-sensitive answers were kept (calibrated inference)
    const style = r.answers.find((a) => a.sectionId === "brand_look")!;
    expect(style.status).toBe("inferred");
    expect(style.answer).toContain("read for");
    // every section answered (v5: no sensitive section to downgrade)
    const lifestyle = r.answers.find((a) => a.sectionId === "lifestyle_daily")!;
    expect(lifestyle.status).toBe("inferred");
    expect(r.model).toBe("gemini-2.5-pro");
    expect(r.version).toBe(PREFERENCE_SYNTHESIS_VERSION);
  });

  it("questions-subset path: only the involved sections are called, only those answers returned", async () => {
    const subset = SECTION_OF("food_drink"); // 5 questions, one section
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
    expect(r.answers.every((a) => a.sectionId === "food_drink")).toBe(true);
    expect([...new Set(calledSections)]).toEqual(["food_drink"]); // only one section, read by 4 agents
    expect(calledSections).toHaveLength(4);
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
        if (sectionId === "food_drink") {
          return {
            ok: true,
            json: async () =>
              wrap(SECTION_OF("food_drink").map((q) => ({ questionId: q.id, status: "inferred", answer: `ok ${q.id}`, confidence: "low", source: "aggregate" }))),
          } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response; // all other sections fail
      }),
    );

    const result = await synthesizePreferences({ contentItems: [content({ text: "ramen" })], mediaAnalyses: [] });
    const r = result as PreferenceSynthesisResult;
    expect(r).not.toBeNull();
    expect(r.answers).toHaveLength(PREFERENCE_QUESTIONS.length);
    expect(r.answers.filter((a) => a.sectionId === "food_drink").every((a) => a.status === "inferred")).toBe(true);
    expect(r.answers.filter((a) => a.sectionId === "travel_places").every((a) => a.status === "unknown")).toBe(true);
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

describe("SECTION_EVIDENCE (v5 routing)", () => {
  it("keys all six v5 sections (Romance removed)", () => {
    expect(new Set(Object.keys(SECTION_EVIDENCE))).toEqual(
      new Set(["brand_look", "food_drink", "travel_places", "social_vibe", "lifestyle_daily", "mindset_values"]),
    );
    expect("partner_romance" in SECTION_EVIDENCE).toBe(false);
  });
});

describe("aggregateLifestyleFacts (v5 lifestyle cards)", () => {
  it("aggregates brands/colours/eyewear/footwear/foods/places/solo-vs-social/events across completed media", () => {
    const facts = aggregateLifestyleFacts([
      media(
        {
          status: "completed",
          vision: { logos: ["Nike"], faces: { count: 3 } },
          semantic: {
            brands: ["Apple"],
            clothing: [{ type: "jacket", color: "black", brand: "Apple" }],
            colorAesthetic: ["black"],
            eyewear: { present: true, style: "round" },
            footwear: { type: "sneakers", model: "Air Jordan" },
            foodDrink: ["coffee"],
            cuisineCategory: "Italian",
            placeGuess: "Mumbai",
            timeOfDay: "morning",
            surroundings: "rooftop cafe",
            isGroup: true,
            eventType: "party",
          },
        },
        "h1",
      ),
      media(
        {
          status: "completed",
          semantic: { colorAesthetic: ["black"], eyewear: { present: false }, foodDrink: ["coffee"], socialSetting: "solo", timeOfDay: "morning", eventType: "casual" },
        },
        "h2",
      ),
      media({ status: "pending", semantic: { brands: ["Ignored"] } }, "h3"), // not completed → ignored
    ]);

    expect(facts.sampleSize).toBe(2);
    expect(facts.topBrands.map((b) => b.value.toLowerCase())).toEqual(expect.arrayContaining(["apple", "nike"]));
    expect(facts.topColours[0].value.toLowerCase()).toBe("black");
    expect(facts.topColours[0].count).toBe(3); // h1 colorAesthetic + h1 clothing colour + h2 colorAesthetic
    expect(facts.eyewear).toMatchObject({ present: 1, absent: 1 });
    expect(facts.footwear[0].value).toBe("sneakers (Air Jordan)");
    expect(facts.foods.map((f) => f.value.toLowerCase())).toEqual(expect.arrayContaining(["coffee"]));
    expect(facts.places.map((p) => p.value)).toContain("Mumbai");
    expect(facts.soloVsSocial).toEqual({ solo: 1, group: 1 });
    expect(facts.timeOfDay[0]).toMatchObject({ value: "morning", count: 2 });
    expect(facts.events).toMatchObject({ events: 1, casual: 1 });
  });

  it("v5.1: de-noises cards — drops generic visual noise, wordy descriptions, table items, and reverse-image place labels", () => {
    const facts = aggregateLifestyleFacts([
      media(
        {
          status: "completed",
          vision: { landmarks: [], bestGuessLabels: ["Businessperson", "Presentation"] }, // reverse-image noise → must NOT become places
          semantic: {
            brands: ["Apple", "Logo", "Product"], // "Logo"/"Product" are generic → dropped
            foodDrink: ["coffee", "Water Bottle", "null"], // "water bottle"/"null" → dropped (v5.2)
            tableItems: ["Small Plant"], // not routed to foods at all
            placeGuess: "Tokyo",
            landmarksSeen: ["Earth", "World"], // planet-scale → dropped (v5.2)
            surroundings: "Digital Graphic With Map Elements", // 5 words → dropped by word-count cap
          },
        },
        "h1",
      ),
    ]);
    expect(facts.topBrands.map((b) => b.value)).toEqual(["Apple"]); // generic "Logo"/"Product" filtered
    expect(facts.foods.map((f) => f.value.toLowerCase())).toEqual(["coffee"]); // no "water bottle"/"null"
    expect(facts.places.map((p) => p.value)).toEqual(["Tokyo"]); // no "Earth"/"World"
    expect(facts.surroundings).toEqual([]); // wordy description dropped
  });

  it("is empty-safe on no/!completed media", () => {
    const facts = aggregateLifestyleFacts([]);
    expect(facts.sampleSize).toBe(0);
    expect(facts.topBrands).toEqual([]);
    expect(facts.soloVsSocial).toEqual({ solo: 0, group: 0 });
  });
});

describe("PREFERENCE_SYNTHESIS_VERSION (auto-derived)", () => {
  it("is a stable v3.1-<12 hex> hash so it bumps automatically on synthesis changes", () => {
    expect(PREFERENCE_SYNTHESIS_VERSION).toMatch(/^v3\.1-[0-9a-f]{12}$/);
  });
});

describe("buildPreferenceSummary", () => {
  it("renders the warm headline from coverage + platforms", () => {
    expect(buildPreferenceSummary({ answeredTotal: 25, total: 30, platforms: ["instagram", "threads", "x"] })).toBe(
      "One has a read on 25 of 30 sides of your taste — drawn from how you show up across Instagram, Threads and X.",
    );
  });
  it("falls back to 'your socials' when platforms are empty", () => {
    expect(buildPreferenceSummary({ answeredTotal: 0, total: 30, platforms: [] })).toContain("your socials");
  });
});

describe("engagement-grounded selection + confidence (rev 4)", () => {
  it("engagementScore: 0 for none, log-scaled and capped at 1", () => {
    expect(engagementScore(null)).toBe(0);
    expect(engagementScore({})).toBe(0);
    const low = engagementScore({ likeCount: "10" });
    const high = engagementScore({ likeCount: "1.2M" });
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(1);
    expect(engagementScore({ viewCount: "5,000" })).toBeGreaterThan(0);
  });

  it("tags self-declared snippets and ranks the high-engagement keyword post first", () => {
    const ctx = buildSectionContext(
      "brand_look",
      [
        content({ itemId: "plain", platform: "x", itemType: "tweet", text: "the weather is fine today" }),
        content({ itemId: "viral", platform: "x", itemType: "tweet", text: "my go-to luxury brand is timeless", metrics: { likeCount: "250K" } }),
      ],
      [],
    );
    expect(ctx.textSnippets[0].id).toBe("viral"); // keyword + engagement + self-declared outrank plain
    expect(ctx.textSnippets.find((s) => s.id === "viral")!.selfDeclared).toBe(true);
    expect(ctx.textSnippets.find((s) => s.id === "plain")!.selfDeclared).toBe(false);
  });

  it("per-agent floor: 0 citations → low; otherwise the model's confidence is kept (the HIGH cap is applied at merge)", () => {
    const q = PREFERENCE_QUESTIONS[0];
    const mk = (evidenceIds: string[]) =>
      parseSectionAnswers(
        wrap([{ questionId: q.id, status: "inferred", answer: "X", confidence: "high", source: "observed", evidenceIds }]),
        [q],
      )[0];
    expect(mk([]).confidence).toBe("low"); // 0 citations → low (ungrounded)
    expect(mk(["a"]).confidence).toBe("high"); // per-agent no longer caps at 1 — merge enforces the ≥2-for-high rule
    expect(mk(["a", "b"]).confidence).toBe("high");
  });
});

describe("mergeAnswerPair (2-agent consensus)", () => {
  const q = PREFERENCE_QUESTIONS[0];
  const ans = (over: Partial<SynthesizedAnswer>): SynthesizedAnswer => ({
    questionId: q.id, sectionId: q.sectionId, prompt: q.prompt, status: "inferred", answer: "A",
    confidence: "low", source: "inferred", evidenceIds: [], mediaEvidenceIds: [], why: null, needsUserConfirmation: false, ...over,
  });

  it("HIGH needs ≥2 distinct citations across the two reads (one each → high)", () => {
    const m = mergeAnswerPair(ans({ confidence: "high", mediaEvidenceIds: ["h1"] }), ans({ confidence: "high", mediaEvidenceIds: ["h2"] }));
    expect(m.confidence).toBe("high");
    expect(new Set(m.mediaEvidenceIds)).toEqual(new Set(["h1", "h2"]));
  });

  it("both agents committed + ≥1 citation but model said low → lifted to medium (consensus)", () => {
    const m = mergeAnswerPair(ans({ confidence: "low", mediaEvidenceIds: ["h1"] }), ans({ confidence: "low" }));
    expect(m.confidence).toBe("medium");
  });

  it("ungrounded lone guess stays low; a single read's high is capped to medium (only 1 citation)", () => {
    expect(mergeAnswerPair(ans({ confidence: "low" }), ans({ status: "unknown", answer: null, confidence: "low" })).confidence).toBe("low");
    expect(mergeAnswerPair(ans({ confidence: "high", evidenceIds: ["a"] }), ans({ status: "unknown", answer: null, confidence: "low" })).confidence).toBe("medium");
  });
});
