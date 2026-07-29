import { describe, expect, it } from "vitest";
import { directoryRowToProfile, expiresAtFor, placeToProfile } from "./normalize";
import type { DiscoverySearchContext } from "./types";
import type { PlaceResult } from "./providers/places";
import type { DirectoryRow } from "@/lib/directory/query";

function ctx(overrides: Partial<DiscoverySearchContext> = {}): DiscoverySearchContext {
  return {
    lat: 47.68,
    lng: -122.2,
    radiusMeters: 5000,
    countryCode: "US",
    approximateOrigin: false,
    limit: 50,
    filters: {},
    allowPaid: true,
    deadlineAt: Date.now() + 5000,
    ...overrides,
  };
}

describe("local-discovery/normalize", () => {
  it("expiresAtFor uses provider-aware TTLs (places < grounded < directory)", () => {
    const from = Date.parse("2026-01-01T00:00:00.000Z");
    const places = Date.parse(expiresAtFor("google_places", from));
    const grounded = Date.parse(expiresAtFor("grounded_web", from));
    const dir = Date.parse(expiresAtFor("directory", from));
    expect(places).toBeLessThan(grounded);
    expect(grounded).toBeLessThan(dir);
  });

  describe("placeToProfile", () => {
    const place: PlaceResult = {
      id: "ChIJ123",
      name: "Grand Hotel",
      formattedAddress: "1 Main St, Kirkland, WA 98033, USA",
      city: "Kirkland",
      state: "WA",
      postalCode: "98033",
      countryCode: "US",
      lat: 47.681,
      lng: -122.205,
      rating: 4.5,
      userRatingCount: 210,
      phone: "+1 425 555 0100",
      website: "https://grand.example",
      primaryType: "hotel",
      primaryTypeDisplayName: "Hotel",
      hasPhotos: true,
      photoName: "places/ChIJ123/photos/abc",
    };

    it("maps a Places result into the unified contract with google_places provenance", () => {
      const p = placeToProfile(place, ctx(), "hotels");
      expect(p.id).toBe("hotels:ChIJ123");
      expect(p.externalIds.google_places).toBe("ChIJ123");
      expect(p.location).toEqual({ lat: 47.681, lng: -122.205, precision: "rooftop" });
      expect(p.provenance.imageUrl).toBe("google_places"); // photo availability recorded, no URL cached
      expect(p.imageUrl).toBeUndefined();
      expect(p.sources[0].kind).toBe("google_places");
      expect(p.quality).not.toBe("insufficient");
      expect(typeof p.distanceMeters).toBe("number");
      expect(p.distanceApproximate).toBe(false);
    });

    it("marks distance approximate when the ORIGIN is approximate, but keeps rooftop precision", () => {
      const p = placeToProfile(place, ctx({ approximateOrigin: true }), "hotels");
      expect(p.approximateLocation).toBe(false); // the place itself is rooftop
      expect(p.distanceApproximate).toBe(true); // but our origin was a centroid
    });
  });

  describe("directoryRowToProfile", () => {
    it("normalizes a hotels row as directory-sourced", () => {
      const row: DirectoryRow = {
        vertical: "hotels",
        id: "42",
        name: "Seed Hotel",
        subtitle: "Hotel",
        distanceM: 120,
        geoPrecision: "rooftop",
        lat: 47.6812,
        lng: -122.206,
        fields: {
          address: "2 Lake St",
          phone: "+1 425 555 0101",
          website: "https://seed.example",
          rating: 4.2,
          userRatingsTotal: 88,
          state: "WA",
          zip: "98033",
          primaryType: "hotel",
          photosCount: 3,
        },
      };
      const p = directoryRowToProfile(row, ctx(), "hotels");
      expect(p.id).toBe("hotels:dir_42");
      expect(p.externalIds.directory_hotels).toBe("42");
      expect(p.sources[0].kind).toBe("directory");
      expect(p.provenance.imageUrl).toBe("directory");
      expect(p.approximateLocation).toBe(false);
    });

    it("normalizes a healthcare row as a ZIP-centroid registry record with honest distance", () => {
      const row: DirectoryRow = {
        vertical: "healthcare",
        id: "row1",
        name: "Dr. Jane Smith",
        subtitle: "Family Medicine",
        distanceM: 0,
        geoPrecision: "zip_centroid",
        lat: 47.68,
        lng: -122.2, // identical to origin → raw distance 0
        fields: {
          npi: "1234567890",
          credential: "MD",
          specialty: "Family Medicine",
          addressLine1: "3 Care Blvd",
          city: "Kirkland",
          state: "WA",
          zip: "98033",
        },
      };
      const p = directoryRowToProfile(row, ctx(), "healthcare");
      expect(p.id).toBe("healthcare:npi_1234567890");
      expect(p.externalIds.npi).toBe("1234567890");
      expect(p.sources[0].kind).toBe("registry");
      expect(p.credentials).toEqual(["MD"]);
      expect(p.approximateLocation).toBe(true);
      expect(p.distanceApproximate).toBe(true);
      // Never a misleading 0 m from a centroid — honestDistanceMeters floors it.
      expect(p.distanceMeters).toBeGreaterThan(0);
    });
  });
});
