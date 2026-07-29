import { describe, expect, it } from "vitest";
import { classifyQuality, scoreProfile, withQuality } from "./quality";
import type { UnifiedProfile } from "./types";

function base(overrides: Partial<UnifiedProfile> = {}): UnifiedProfile {
  return {
    id: "hotels:x",
    category: "hotels",
    name: "Somewhere",
    externalIds: {},
    sources: [{ kind: "google_places", label: "Google" }],
    provenance: {},
    qualityScore: 0,
    quality: "insufficient",
    distanceApproximate: false,
    approximateLocation: false,
    fetchedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("local-discovery/quality", () => {
  it("classifies by threshold", () => {
    expect(classifyQuality(90)).toBe("rich");
    expect(classifyQuality(60)).toBe("standard");
    expect(classifyQuality(30)).toBe("basic");
    expect(classifyQuality(10)).toBe("insufficient");
  });

  it("floors a name-only (+postal) record to insufficient however many light fields it has", () => {
    const p = base({ name: "Ghost Clinic", postalCode: "98033", countryCode: "US", city: "Kirkland" });
    const { score, quality } = scoreProfile(p);
    expect(quality).toBe("insufficient");
    expect(score).toBeLessThanOrEqual(20);
  });

  it("rewards a substantive, corroborated, rooftop profile", () => {
    const p = base({
      name: "Grand Hotel",
      address: "1 Main St",
      city: "Kirkland",
      postalCode: "98033",
      countryCode: "US",
      phone: "+1 425 555 0100",
      website: "https://grand.example",
      rating: 4.6,
      reviewCount: 320,
      location: { lat: 47.68, lng: -122.2, precision: "rooftop" },
      openingHours: { weekdayText: ["Mon: 9-5"] },
      provenance: { imageUrl: "google_places" },
      sources: [
        { kind: "google_places", label: "Google" },
        { kind: "directory", label: "Hushh" },
      ],
    });
    const { score, quality } = scoreProfile(p);
    expect(score).toBeGreaterThanOrEqual(75);
    expect(quality).toBe("rich");
  });

  it("treats a centroid location as weaker than a rooftop one", () => {
    const common = {
      name: "Clinic",
      address: "5 Elm St",
      phone: "+1 425 555 0100",
      rating: 4,
    } as const;
    const rooftop = scoreProfile(base({ ...common, location: { lat: 1, lng: 1, precision: "rooftop" } }));
    const centroid = scoreProfile(
      base({ ...common, approximateLocation: true, location: { lat: 1, lng: 1, precision: "zip_centroid" } }),
    );
    expect(rooftop.score).toBeGreaterThan(centroid.score);
  });

  it("withQuality writes score + bucket onto the profile", () => {
    const p = withQuality(base({ name: "X", address: "1 St", phone: "123", rating: 4, website: "https://x.example" }));
    expect(p.qualityScore).toBeGreaterThan(0);
    expect(["rich", "standard", "basic", "insufficient"]).toContain(p.quality);
  });
});
