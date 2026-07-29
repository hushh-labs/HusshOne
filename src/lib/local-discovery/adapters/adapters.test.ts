import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the infra-bound layers so the adapter pipeline runs with zero DB / network.
vi.mock("@/lib/directory/db", () => ({
  hasDirectoryDb: vi.fn(() => true),
}));
vi.mock("@/lib/directory/query", () => ({
  queryVertical: vi.fn(),
}));
vi.mock("../providers/places", () => ({
  hasPlacesProvider: vi.fn(() => true),
  searchPlaces: vi.fn(),
}));

import { hasDirectoryDb } from "@/lib/directory/db";
import { queryVertical } from "@/lib/directory/query";
import type { DirectoryRow, VerticalQueryResult } from "@/lib/directory/query";
import { hasPlacesProvider, searchPlaces } from "../providers/places";
import type { PlaceResult, PlacesSearchOutput } from "../providers/places";
import { RequestBudget } from "../spend";
import type { DiscoverySearchContext, LocalDiscoveryAdapter } from "../types";
import { hotelsAdapter } from "./hotels";
import { healthcareAdapter } from "./healthcare";
import { adaptersForCountry, adapterFor, supportsCountry } from "./index";

const mockQueryVertical = vi.mocked(queryVertical);
const mockSearchPlaces = vi.mocked(searchPlaces);
const mockHasDirectoryDb = vi.mocked(hasDirectoryDb);
const mockHasPlacesProvider = vi.mocked(hasPlacesProvider);

function ctx(overrides: Partial<DiscoverySearchContext> = {}): DiscoverySearchContext {
  return {
    lat: 47.68,
    lng: -122.2,
    radiusMeters: 5000,
    countryCode: "US",
    approximateOrigin: false,
    limit: 20,
    filters: {},
    allowPaid: true,
    budget: new RequestBudget(),
    deadlineAt: Date.now() + 5000,
    ...overrides,
  };
}

function hotelRow(overrides: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    vertical: "hotels",
    id: "1",
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
    ...overrides,
  };
}

function healthcareRow(overrides: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    vertical: "healthcare",
    id: "row1",
    name: "Dr. Jane Smith",
    subtitle: "Family Medicine",
    distanceM: 0,
    geoPrecision: "zip_centroid",
    lat: 47.68,
    lng: -122.2,
    fields: {
      npi: "1234567890",
      credential: "MD",
      specialty: "Family Medicine",
      addressLine1: "3 Care Blvd",
      city: "Kirkland",
      state: "WA",
      zip: "98033",
      phone: "+1 425 555 0111",
    },
    ...overrides,
  };
}

function place(overrides: Partial<PlaceResult> = {}): PlaceResult {
  return {
    id: "ChIJlive",
    name: "Live Place",
    formattedAddress: "9 Live Ave, Kirkland, WA 98033, USA",
    city: "Kirkland",
    state: "WA",
    postalCode: "98033",
    countryCode: "US",
    lat: 47.679,
    lng: -122.21,
    rating: 4.7,
    userRatingCount: 400,
    phone: "+1 425 555 0999",
    website: "https://live.example",
    primaryType: "lodging",
    primaryTypeDisplayName: "Hotel",
    hasPhotos: true,
    photoName: "places/ChIJlive/photos/x",
    ...overrides,
  };
}

function qResult(rows: DirectoryRow[], error?: string): VerticalQueryResult {
  return { vertical: rows[0]?.vertical ?? "hotels", rows, error };
}
function pResult(results: PlaceResult[], skipped?: PlacesSearchOutput["skipped"]): PlacesSearchOutput {
  return { results, calls: skipped ? 0 : 1, skipped };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHasDirectoryDb.mockReturnValue(true);
  mockHasPlacesProvider.mockReturnValue(true);
});

describe("local-discovery/adapters — registry", () => {
  it("maps categories to their adapters", () => {
    expect(adapterFor("hotels")).toBe(hotelsAdapter);
    expect(adapterFor("healthcare")).toBe(healthcareAdapter);
  });

  it("supportsCountry: 'all' always matches; explicit list is case-insensitive", () => {
    expect(supportsCountry(hotelsAdapter, "IN")).toBe(true);
    expect(supportsCountry(healthcareAdapter, "IN")).toBe(true);
    const usOnly = { supportedCountries: ["US"] } as unknown as LocalDiscoveryAdapter;
    expect(supportsCountry(usOnly, "us")).toBe(true);
    expect(supportsCountry(usOnly, "IN")).toBe(false);
    expect(supportsCountry(usOnly, undefined)).toBe(false);
  });

  it("adaptersForCountry preserves order and drops unknown categories", () => {
    const list = adaptersForCountry(["healthcare", "hotels"], "IN");
    expect(list.map((a) => a.category)).toEqual(["healthcare", "hotels"]);
  });
});

describe("local-discovery/adapters — hotels", () => {
  it("combines directory seed with live Places enrichment (not degraded)", async () => {
    mockQueryVertical.mockResolvedValue(qResult([hotelRow()]));
    mockSearchPlaces.mockResolvedValue(pResult([place()]));

    const res = await hotelsAdapter.search(ctx());

    expect(mockQueryVertical).toHaveBeenCalledWith("hotels", expect.objectContaining({ radiusM: 5000 }));
    expect(mockSearchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({ includedTypes: ["lodging"], regionCode: "US" }),
      expect.any(RequestBudget),
    );
    expect(res.category).toBe("hotels");
    expect(res.profiles).toHaveLength(2); // distinct entities, not merged
    expect(res.sourcesUsed.sort()).toEqual(["directory", "google_places"]);
    expect(res.degraded).toBe(false);
  });

  it("stays on seed only and marks degraded when paid calls are disabled", async () => {
    mockQueryVertical.mockResolvedValue(qResult([hotelRow()]));

    const res = await hotelsAdapter.search(ctx({ allowPaid: false }));

    expect(mockSearchPlaces).not.toHaveBeenCalled();
    expect(res.profiles).toHaveLength(1);
    expect(res.sourcesUsed).toEqual(["directory"]);
    expect(res.degraded).toBe(true);
    expect(res.warnings.some((w) => /paid calls disabled/.test(w))).toBe(true);
  });

  it("degrades to seed with a warning when the budget gates the live call", async () => {
    mockQueryVertical.mockResolvedValue(qResult([hotelRow()]));
    mockSearchPlaces.mockResolvedValue(pResult([], "budget"));

    const res = await hotelsAdapter.search(ctx());

    expect(res.degraded).toBe(true);
    expect(res.profiles).toHaveLength(1);
    expect(res.warnings.some((w) => /budget/.test(w))).toBe(true);
  });

  it("isolates a seed failure: still returns live results, never throws", async () => {
    mockQueryVertical.mockResolvedValue(qResult([], "connection refused"));
    mockSearchPlaces.mockResolvedValue(pResult([place()]));

    const res = await hotelsAdapter.search(ctx());

    expect(res.profiles).toHaveLength(1);
    expect(res.sourcesUsed).toEqual(["google_places"]);
    expect(res.degraded).toBe(false);
    expect(res.warnings.some((w) => /seed unavailable/.test(w))).toBe(true);
  });

  it("returns an empty, degraded result when neither seed DB nor live is available", async () => {
    mockHasDirectoryDb.mockReturnValue(false);

    const res = await hotelsAdapter.search(ctx({ allowPaid: false }));

    expect(mockQueryVertical).not.toHaveBeenCalled();
    expect(res.profiles).toEqual([]);
    expect(res.sourcesUsed).toEqual([]);
    expect(res.degraded).toBe(true);
  });
});

describe("local-discovery/adapters — healthcare", () => {
  it("seeds the NPPES registry and enriches with Places for a US search", async () => {
    mockQueryVertical.mockResolvedValue(qResult([healthcareRow()]));
    mockSearchPlaces.mockResolvedValue(
      pResult([place({ id: "ChIJdoc", name: "Kirkland Clinic", primaryType: "doctor" })]),
    );

    const res = await healthcareAdapter.search(ctx({ countryCode: "US" }));

    expect(mockQueryVertical).toHaveBeenCalledWith("healthcare", expect.objectContaining({ radiusM: 5000 }));
    expect(mockSearchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({ includedTypes: ["doctor", "hospital"] }),
      expect.any(RequestBudget),
    );
    expect(res.sourcesUsed.sort()).toEqual(["google_places", "registry"]);
    expect(res.degraded).toBe(false);
  });

  it("never seeds the US registry for a non-US search — live only, with a warning", async () => {
    mockSearchPlaces.mockResolvedValue(pResult([place({ countryCode: "IN", name: "Mumbai Clinic" })]));

    const res = await healthcareAdapter.search(ctx({ countryCode: "IN" }));

    expect(mockQueryVertical).not.toHaveBeenCalled();
    expect(res.sourcesUsed).toEqual(["google_places"]);
    expect(res.warnings.some((w) => /NPPES covers the US only/.test(w))).toBe(true);
    expect(res.degraded).toBe(false);
  });
});
