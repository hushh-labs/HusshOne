import { describe, expect, it } from "vitest";
import { dedupeAndMerge, normalizeName } from "./merge";
import type { SourceKind, UnifiedProfile } from "./types";

function prof(overrides: Partial<UnifiedProfile> & { id: string; name: string }): UnifiedProfile {
  const sources = overrides.sources ?? [{ kind: "google_places" as SourceKind, label: "Google" }];
  return {
    category: "hotels",
    externalIds: {},
    provenance: {},
    qualityScore: 50,
    quality: "standard",
    distanceApproximate: false,
    approximateLocation: false,
    fetchedAt: new Date(0).toISOString(),
    ...overrides,
    sources,
  };
}

describe("local-discovery/merge", () => {
  it("normalizeName folds case, punctuation, and ampersands", () => {
    expect(normalizeName("Ben & Jerry's")).toBe("ben and jerry s");
    expect(normalizeName("  The  Grand-Hotel!! ")).toBe("the grand hotel");
  });

  it("merges a directory seed and a Places hit for the same entity by shared place_id", () => {
    const dir = prof({
      id: "hotels:dir_1",
      name: "Grand Hotel",
      phone: "+1 425 555 0100",
      externalIds: { directory_hotels: "1", google_places: "ChIJ1" },
      sources: [{ kind: "directory", label: "Hushh" }],
      provenance: { name: "directory", phone: "directory" },
    });
    const gp = prof({
      id: "hotels:ChIJ1",
      name: "Grand Hotel",
      rating: 4.7,
      reviewCount: 500,
      website: "https://grand.example",
      location: { lat: 47.68, lng: -122.2, precision: "rooftop" },
      externalIds: { google_places: "ChIJ1" },
      provenance: { name: "google_places", rating: "google_places", website: "google_places", location: "google_places" },
    });
    const merged = dedupeAndMerge([dir, gp]);
    expect(merged).toHaveLength(1);
    const m = merged[0];
    // Stable internal id prefers our own directory namespace over the volatile place id.
    expect(m.id).toBe("hotels:dir_1");
    // Field preference: Places wins rating/location, directory-sourced phone retained.
    expect(m.rating).toBe(4.7);
    expect(m.provenance.rating).toBe("google_places");
    expect(m.phone).toBe("+1 425 555 0100");
    // Both sources retained for attribution.
    expect(m.sources.map((s) => s.kind).sort()).toEqual(["directory", "google_places"]);
    // Re-scored: richer than either input alone.
    expect(m.qualityScore).toBeGreaterThanOrEqual(50);
  });

  it("registry credentials win over other sources; maps ratings win", () => {
    const registry = prof({
      id: "healthcare:npi_9",
      name: "Dr Jane Smith",
      category: "healthcare",
      credentials: ["MD"],
      phone: "+1 425 555 0111",
      externalIds: { npi: "9" },
      sources: [{ kind: "registry", label: "NPPES" }],
      provenance: { name: "registry", credentials: "registry", phone: "registry" },
    });
    const gp = prof({
      id: "healthcare:ChIJ9",
      name: "Dr Jane Smith",
      category: "healthcare",
      rating: 4.9,
      reviewCount: 40,
      credentials: ["Doctor"],
      phone: "+1 425 555 0111",
      location: { lat: 1, lng: 1, precision: "rooftop" },
      externalIds: { google_places: "ChIJ9" },
      sources: [{ kind: "google_places", label: "Google" }],
      provenance: { name: "google_places", rating: "google_places", credentials: "google_places" },
    });
    const [m] = dedupeAndMerge([registry, gp]);
    expect(m.provenance.credentials).toBe("registry");
    expect(m.rating).toBe(4.9);
    expect(m.provenance.rating).toBe("google_places");
    // union of credentials, registry value first.
    expect(m.credentials).toContain("MD");
  });

  it("links two rows by fuzzy name + proximity (<=150 m) when no id/phone is shared", () => {
    const a = prof({
      id: "hotels:dir_2",
      name: "Lakeside Inn",
      location: { lat: 47.6800, lng: -122.2000, precision: "rooftop" },
      externalIds: { directory_hotels: "2" },
      sources: [{ kind: "directory", label: "Hushh" }],
    });
    const b = prof({
      id: "hotels:ChIJ2",
      name: "Lakeside Inn",
      rating: 4.1,
      location: { lat: 47.68005, lng: -122.20005, precision: "rooftop" }, // ~7 m away
      externalIds: { google_places: "ChIJ2" },
      sources: [{ kind: "google_places", label: "Google" }],
    });
    expect(dedupeAndMerge([a, b])).toHaveLength(1);
  });

  it("does NOT merge same-name entities that are far apart", () => {
    const a = prof({
      id: "hotels:dir_3",
      name: "City Cafe",
      location: { lat: 47.68, lng: -122.2, precision: "rooftop" },
      externalIds: { directory_hotels: "3" },
    });
    const b = prof({
      id: "hotels:dir_4",
      name: "City Cafe",
      location: { lat: 40.0, lng: -74.0, precision: "rooftop" }, // different city
      externalIds: { directory_hotels: "4" },
    });
    expect(dedupeAndMerge([a, b])).toHaveLength(2);
  });

  it("returns the input untouched when there is nothing to merge", () => {
    const a = prof({ id: "hotels:a", name: "A", externalIds: { google_places: "a" } });
    expect(dedupeAndMerge([a])).toEqual([a]);
    expect(dedupeAndMerge([])).toEqual([]);
  });
});
