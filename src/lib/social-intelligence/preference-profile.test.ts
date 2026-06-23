import { describe, expect, it } from "vitest";
import { buildUserPreferenceProfile, PREFERENCE_QUESTIONS, PROFILE_VERSION, QUESTION_REGISTRY_VERSION } from "./preference-profile";

describe("buildUserPreferenceProfile", () => {
  it("clusters visible social posts into evidence-backed preferences", () => {
    const profile = buildUserPreferenceProfile({
      socialProfiles: [
        {
          platform: "Instagram",
          username: "ankit",
          displayName: "Ankit",
          bio: "Builder",
          avatarUrl: null,
          externalUrl: null,
          profileUrl: "https://www.instagram.com/ankit/",
          source: "scraper",
          recentPublicPosts: [
            {
              url: "https://www.instagram.com/p/abc/",
              caption: "Goa mornings. Need this sea view and coffee again.",
              thumbnailUrl: "https://cdn.example.com/goa.jpg",
            },
            {
              url: "https://www.instagram.com/p/def/",
              caption: "Black minimal product UI, blue accents, clean typography.",
              thumbnailUrl: "https://cdn.example.com/ui.jpg",
            },
          ],
        },
        {
          platform: "Threads",
          username: "ankit",
          displayName: "Ankit",
          bio: "Product thoughts",
          avatarUrl: null,
          externalUrl: null,
          profileUrl: "https://www.threads.com/@ankit",
          source: "scraper",
          recentThreads: [
            {
              url: "https://www.threads.com/@ankit/post/Cabc123",
              text: "AI product privacy startup ideas, long post about user data and product design.",
              mediaUrls: [],
            },
          ],
        },
        {
          platform: "X",
          username: "ankit",
          handle: "ankit",
          displayName: "Ankit",
          bio: "Ship fast.",
          avatarUrl: null,
          bannerUrl: null,
          externalUrl: null,
          profileUrl: "https://x.com/ankit",
          source: "scraper",
          timelineItems: [
            {
              url: "https://x.com/ankit/status/123",
              tab: "replies",
              isReply: true,
              text: "Ship now. Clear product thinking around AI and privacy!",
              likeCount: "12",
            },
          ],
        },
      ],
      now: new Date("2026-06-17T09:00:00.000Z"),
    });

    expect(profile.updatedFrom.indexedItems).toBeGreaterThanOrEqual(5);
    expect(profile.version).toBe(PROFILE_VERSION);
    expect(profile.questionRegistryVersion).toBe(QUESTION_REGISTRY_VERSION);
    expect(PREFERENCE_QUESTIONS).toHaveLength(30);
    expect(profile.questionAnswers).toHaveLength(30);
    expect(profile.sectionSummaries).toHaveLength(6);
    expect(profile.questionCoverage).toMatchObject({
      total: 30,
      bySection: expect.any(Object),
    });
    expect(profile.updatedFrom.mediaAssets).toBe(2);
    expect(profile.selection).toMatchObject({
      evidencePoolSize: expect.any(Number),
      selectedSignalCount: expect.any(Number),
      droppedEvidenceCount: 0,
    });
    expect(profile.selection.selectedEvidenceCount).toBeGreaterThan(0);
    expect(profile.selection.selectedEvidenceIds.length).toBeGreaterThan(0);
    expect(profile.selection.selectionRules).toMatchObject({
      evidenceCap: 2600,
      topSignalCap: 12,
      signalEvidenceCap: 12,
      collageCap: 16,
    });
    expect(profile.topSignals.map((signal) => signal.label)).toEqual(
      expect.arrayContaining([
        "seaside / beach-view places",
        "coffee and cafes",
        "black / blue / white minimal palette",
        "AI, product, privacy, and startup building",
      ]),
    );
    // v5 section ids: travel_kind_of_place / look_color_palette / food_go_to_cuisine (Romance removed).
    expect(profile.questionAnswers.find((answer) => answer.questionId === "travel_kind_of_place")).toMatchObject({
      status: expect.stringMatching(/answered|inferred|needs_confirmation/),
      normalizedValue: "beach",
      evidenceIds: expect.arrayContaining([expect.any(String)]),
    });
    expect(profile.questionAnswers.find((answer) => answer.questionId === "look_color_palette")).toMatchObject({
      status: expect.stringMatching(/answered|inferred|needs_confirmation/),
      evidenceIds: expect.arrayContaining([expect.any(String)]),
    });
    expect(profile.questionAnswers.find((answer) => answer.questionId === "food_go_to_cuisine")).toMatchObject({
      status: expect.stringMatching(/answered|inferred|needs_confirmation/),
      evidenceIds: expect.arrayContaining([expect.any(String)]),
    });
    // No question is sensitive in v5 (Partner & Romance section removed).
    expect(PREFERENCE_QUESTIONS.some((q) => q.sensitive)).toBe(false);
    expect(new Set(PREFERENCE_QUESTIONS.map((q) => q.sectionId))).toEqual(
      new Set(["brand_look", "food_drink", "travel_places", "social_vibe", "lifestyle_daily", "mindset_values"]),
    );
    expect(profile.collage.some((item) => item.imageUrl === "https://cdn.example.com/goa.jpg")).toBe(true);
    expect(profile.mediaIntelligence).toMatchObject({
      status: "pending",
      provider: "vertex_gemini_cloud_vision",
      queuedAssets: 2,
    });
    expect(profile.guardrails).toMatchObject({
      linkedinUntouched: true,
      noPrivateContent: true,
      sensitiveInferencePolicy: "self_declared_or_needs_confirmation",
    });
    for (const signal of profile.topSignals) {
      expect(signal.evidenceIds.length).toBeGreaterThan(0);
    }
  });
});
