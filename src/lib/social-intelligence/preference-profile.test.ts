import { describe, expect, it } from "vitest";
import { buildUserPreferenceProfile } from "./preference-profile";

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
    expect(profile.collage.some((item) => item.imageUrl === "https://cdn.example.com/goa.jpg")).toBe(true);
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
