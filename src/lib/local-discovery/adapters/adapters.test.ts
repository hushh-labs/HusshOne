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
import { riaAdapter } from "./ria";
import { insuranceAdapter } from "./insurance";
import { adaptersForCountry, adapterFor, runAdapter, supportsCountry } from "./index";

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

function riaRow(overrides: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    vertical: "ria",
    id: "104567",
    name: "Cascade Wealth Partners LLC",
    subtitle: "AUM $1,240,000,000",
    distanceM: 0,
    geoPrecision: "zip_centroid",
    lat: 47.68,
    lng: -122.2,
    fields: {
      crd: "104567",
      street1: "500 Adviser Way",
      city: "Kirkland",
      state: "WA",
      zip: "98033",
      phone: "+1 425 555 0144",
      website: "https://cascade.example",
      aum: 1_240_000_000,
      totalEmployees: 12,
      registrationStatus: "SEC Registered",
    },
    ...overrides,
  };
}

function insuranceRow(overrides: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    vertical: "insurance",
    id: "TX:1234567",
    name: "Maria Gomez",
    subtitle: "Individual · General Lines",
    distanceM: 0,
    geoPrecision: "zip_centroid",
    lat: 47.68,
    lng: -122.2,
    fields: {
      sourceState: "TX",
      licenseNo: "1234567",
      npn: "18889999",
      entityType: "Individual",
      licenseTypes: ["General Lines"],
      linesOfAuthority: ["Life", "Health"],
      status: "Active",
      addressLine1: "77 Agent Rd",
      city: "Austin",
      state: "TX",
      zip: "78701",
      phone: "+1 512 555 0177",
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
    expect(adapterFor("ria")).toBe(riaAdapter);
    expect(adapterFor("insurance")).toBe(insuranceAdapter);
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

describe("local-discovery/adapters — ria", () => {
  it("seeds SEC firms and enriches via TEXT search (Table A has no adviser type)", async () => {
    mockQueryVertical.mockResolvedValue(qResult([riaRow()]));
    mockSearchPlaces.mockResolvedValue(pResult([place({ id: "ChIJria", name: "Lakeside Advisors" })]));

    const res = await riaAdapter.search(ctx({ countryCode: "US" }));

    expect(mockQueryVertical).toHaveBeenCalledWith("ria", expect.objectContaining({ radiusM: 5000 }));
    // Empty includedTypes + a textQuery is what routes providers/places to places:searchText. Passing a
    // Table A finance type here (accounting/bank) would return the wrong businesses entirely.
    expect(mockSearchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({
        includedTypes: [],
        textQuery: "registered investment adviser financial advisor firm",
      }),
      expect.any(RequestBudget),
    );
    expect(res.category).toBe("ria");
    expect(res.sourcesUsed.sort()).toEqual(["google_places", "registry"]);
    expect(res.degraded).toBe(false);
  });

  it("appends the user's refine to the baseline query instead of replacing it", async () => {
    mockQueryVertical.mockResolvedValue(qResult([riaRow()]));
    mockSearchPlaces.mockResolvedValue(pResult([]));

    await riaAdapter.search(ctx({ filters: { query: "retirement planning" } }));

    expect(mockSearchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({
        textQuery: "registered investment adviser financial advisor firm retirement planning",
      }),
      expect.any(RequestBudget),
    );
  });

  it("never seeds SEC data for a non-US search and says the results are not RIAs", async () => {
    mockSearchPlaces.mockResolvedValue(pResult([place({ countryCode: "IN", name: "Mumbai Wealth" })]));

    const res = await riaAdapter.search(ctx({ countryCode: "IN" }));

    expect(mockQueryVertical).not.toHaveBeenCalled();
    expect(res.warnings.some((w) => /not SEC-registered RIAs/.test(w))).toBe(true);
  });

  it("explains an empty US seed rather than implying there are no adviser firms", async () => {
    mockQueryVertical.mockResolvedValue(qResult([]));
    mockSearchPlaces.mockResolvedValue(pResult([]));

    const res = await riaAdapter.search(ctx({ countryCode: "US" }));

    expect(res.profiles).toEqual([]);
    expect(res.warnings.some((w) => /main-office ZIP/.test(w))).toBe(true);
  });

  it("stays silent about coverage when the seed was never queried", async () => {
    mockHasDirectoryDb.mockReturnValue(false); // no DB wired → seed skipped, not "empty"
    mockSearchPlaces.mockResolvedValue(pResult([]));

    const res = await riaAdapter.search(ctx({ countryCode: "US" }));

    expect(res.warnings.some((w) => /main-office ZIP/.test(w))).toBe(false);
  });
});

describe("local-discovery/adapters — insurance", () => {
  it("seeds DOI licences and enriches via NEARBY search on the insurance_agency type", async () => {
    mockQueryVertical.mockResolvedValue(qResult([insuranceRow()]));
    mockSearchPlaces.mockResolvedValue(pResult([place({ id: "ChIJins", name: "Gomez Insurance" })]));

    const res = await insuranceAdapter.search(ctx({ countryCode: "US" }));

    expect(mockQueryVertical).toHaveBeenCalledWith("insurance", expect.objectContaining({ radiusM: 5000 }));
    // `insurance_agency` IS in Places (New) Table A (Services) — so this category keeps the cheaper,
    // distance-ranked Nearby path and sends no baseline textQuery.
    expect(mockSearchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({ includedTypes: ["insurance_agency"], textQuery: undefined }),
      expect.any(RequestBudget),
    );
    expect(res.category).toBe("insurance");
    expect(res.sourcesUsed.sort()).toEqual(["google_places", "registry"]);
    expect(res.degraded).toBe(false);
  });

  it("flags an empty US seed as a registry coverage gap, not an empty market", async () => {
    mockQueryVertical.mockResolvedValue(qResult([]));
    mockSearchPlaces.mockResolvedValue(pResult([place({ id: "ChIJins2", name: "Seattle Insurance" })]));

    const res = await insuranceAdapter.search(ctx({ countryCode: "US" }));

    expect(res.warnings.some((w) => /coverage gap rather than an empty market/.test(w))).toBe(true);
    expect(res.profiles).toHaveLength(1); // live results still stream
  });

  it("never seeds US licence data for a non-US search", async () => {
    mockSearchPlaces.mockResolvedValue(pResult([place({ countryCode: "IN", name: "Mumbai Insurance" })]));

    const res = await insuranceAdapter.search(ctx({ countryCode: "IN" }));

    expect(mockQueryVertical).not.toHaveBeenCalled();
    expect(res.warnings.some((w) => /US state insurance departments/.test(w))).toBe(true);
  });
});

describe("local-discovery/adapters — shared enrichment guard", () => {
  it("refuses an untyped Places search when a config has neither placeTypes nor textQuery", async () => {
    mockQueryVertical.mockResolvedValue(qResult([]));

    // Without this guard the request would go to Nearby Search with empty includedTypes and return every
    // business in the radius — a plausible mistake when adding the next category.
    const res = await runAdapter(ctx(), { category: "ria", seedVertical: null, placeTypes: [] });

    expect(mockSearchPlaces).not.toHaveBeenCalled();
    expect(res.degraded).toBe(true);
    expect(res.warnings.some((w) => /no place types or text query/.test(w))).toBe(true);
  });
});
