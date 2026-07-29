import { describe, expect, it } from "vitest";
import { rankProfiles } from "./rank";
import type { ProfileQuality, UnifiedProfile } from "./types";

function prof(
  id: string,
  overrides: Partial<UnifiedProfile> = {},
  quality: ProfileQuality = "standard",
): UnifiedProfile {
  return {
    id,
    category: "hotels",
    name: id,
    externalIds: {},
    sources: [{ kind: "google_places", label: "Google" }],
    provenance: {},
    qualityScore: quality === "rich" ? 80 : quality === "standard" ? 60 : quality === "basic" ? 30 : 10,
    quality,
    distanceApproximate: false,
    approximateLocation: false,
    fetchedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("local-discovery/rank", () => {
  it("nearest sorts by ascending distance, unknowns last", () => {
    const out = rankProfiles(
      [
        prof("far", { distanceMeters: 4000 }),
        prof("near", { distanceMeters: 100 }),
        prof("unknown", {}),
        prof("mid", { distanceMeters: 1500 }),
      ],
      { sort: "nearest", radiusMeters: 5000, limit: 10 },
    );
    expect(out.map((p) => p.id)).toEqual(["near", "mid", "far", "unknown"]);
  });

  it("rating sorts by rating desc then reviews", () => {
    const out = rankProfiles(
      [
        prof("a", { rating: 4.0, reviewCount: 10 }),
        prof("b", { rating: 4.8, reviewCount: 5 }),
        prof("c", { rating: 4.8, reviewCount: 500 }),
      ],
      { sort: "rating", radiusMeters: 5000, limit: 10 },
    );
    expect(out.map((p) => p.id)).toEqual(["c", "b", "a"]);
  });

  it("hides insufficient rows when solid rows exist", () => {
    const out = rankProfiles(
      [prof("good", { distanceMeters: 100 }, "standard"), prof("stub", { distanceMeters: 5 }, "insufficient")],
      { sort: "nearest", radiusMeters: 5000, limit: 10 },
    );
    expect(out.map((p) => p.id)).toEqual(["good"]);
  });

  it("falls back to insufficient rows only when nothing better exists", () => {
    const out = rankProfiles([prof("stub", { distanceMeters: 5 }, "insufficient")], {
      sort: "nearest",
      radiusMeters: 5000,
      limit: 10,
    });
    expect(out.map((p) => p.id)).toEqual(["stub"]);
  });

  it("includeInsufficient keeps weak rows but sinks them below solid ones", () => {
    const out = rankProfiles(
      [prof("stub", { distanceMeters: 5 }, "insufficient"), prof("good", { distanceMeters: 4000 }, "rich")],
      { sort: "nearest", radiusMeters: 5000, limit: 10, includeInsufficient: true },
    );
    expect(out.map((p) => p.id)).toEqual(["good", "stub"]);
  });

  it("applies minRating, openNow, subcategory and query filters", () => {
    const list = [
      prof("hiRated", { rating: 4.6 }),
      prof("loRated", { rating: 3.1 }),
      prof("openNowTrue", { rating: 4.6, openingHours: { openNow: true } }),
      prof("closedNow", { rating: 4.6, openingHours: { openNow: false } }),
      prof("unknownHours", { rating: 4.6 }), // no openingHours — must NOT be dropped by openNow
      prof("cardiology", { rating: 4.6, subcategory: "Cardiology" }),
      prof("sushi", { rating: 4.6, name: "Sushi Place", description: "great sushi" }),
    ];
    expect(rankProfiles(list, { radiusMeters: 5000, limit: 10, filters: { minRating: 4.5 } }).map((p) => p.id)).not.toContain("loRated");
    // "Open now" drops only places KNOWN to be closed; open + unknown-hours are kept.
    const openIds = rankProfiles(list, { radiusMeters: 5000, limit: 10, filters: { openNow: true } }).map((p) => p.id);
    expect(openIds).toContain("openNowTrue");
    expect(openIds).toContain("unknownHours");
    expect(openIds).not.toContain("closedNow");
    expect(
      rankProfiles(list, { radiusMeters: 5000, limit: 10, filters: { subcategories: ["cardiology"] } }).map((p) => p.id),
    ).toEqual(["cardiology"]);
    expect(rankProfiles(list, { radiusMeters: 5000, limit: 10, filters: { query: "sushi" } }).map((p) => p.id)).toEqual(["sushi"]);
  });

  it("recommended leads with the richest/closest/best-reviewed and clamps to limit", () => {
    const out = rankProfiles(
      [
        prof("weakFar", { distanceMeters: 4900, rating: 3.0, reviewCount: 1 }, "basic"),
        prof("richNear", { distanceMeters: 200, rating: 4.8, reviewCount: 900 }, "rich"),
      ],
      { sort: "recommended", radiusMeters: 5000, limit: 1 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("richNear");
  });
});
