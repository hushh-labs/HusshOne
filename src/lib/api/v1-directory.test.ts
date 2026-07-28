import { describe, expect, it } from "vitest";
import { parseDirectoryQuery } from "./v1-directory";
import { V1InputError } from "./v1-input";

/** Parse a query string; the validator is synchronous so it either returns or throws. */
function parse(qs: string) {
  return parseDirectoryQuery(new URLSearchParams(qs));
}

/** Run the validator and return whatever it threw (or null if it didn't). */
function caught(qs: string): unknown {
  try {
    parseDirectoryQuery(new URLSearchParams(qs));
    return null;
  } catch (e) {
    return e;
  }
}

describe("parseDirectoryQuery — coordinates", () => {
  it("accepts a valid lat/lng pair", () => {
    const q = parse("lat=47.68&lng=-122.21");
    expect(q.lat).toBe(47.68);
    expect(q.lng).toBe(-122.21);
    expect(q.zip).toBeUndefined();
  });

  it("accepts latitude/longitude/lon aliases", () => {
    expect(parse("latitude=10&longitude=20")).toMatchObject({ lat: 10, lng: 20 });
    expect(parse("lat=10&lon=20")).toMatchObject({ lat: 10, lng: 20 });
  });

  it("rejects a lone latitude or longitude with bad_coordinates", () => {
    for (const qs of ["lat=47.68", "lng=-122.21"]) {
      const e = caught(qs);
      expect(e).toBeInstanceOf(V1InputError);
      expect((e as V1InputError).statusCode).toBe(400);
      expect((e as V1InputError).code).toBe("bad_coordinates");
    }
  });

  it("rejects non-numeric coordinates with bad_coordinates", () => {
    const e = caught("lat=abc&lng=-122.21");
    expect(e).toBeInstanceOf(V1InputError);
    expect((e as V1InputError).code).toBe("bad_coordinates");
  });

  it("rejects out-of-range latitude and longitude", () => {
    expect((caught("lat=999&lng=0") as V1InputError).code).toBe("bad_coordinates");
    expect((caught("lat=0&lng=999") as V1InputError).code).toBe("bad_coordinates");
    expect((caught("lat=-91&lng=0") as V1InputError).code).toBe("bad_coordinates");
  });

  it("accepts the boundary values -90/90 and -180/180", () => {
    expect(parse("lat=90&lng=180")).toMatchObject({ lat: 90, lng: 180 });
    expect(parse("lat=-90&lng=-180")).toMatchObject({ lat: -90, lng: -180 });
  });

  it("throws missing_coordinates when neither coordinates nor zip are given", () => {
    const e = caught("radius=1000");
    expect(e).toBeInstanceOf(V1InputError);
    expect((e as V1InputError).code).toBe("missing_coordinates");
  });

  it("accepts a bare zip (fallback) with no coordinates", () => {
    const q = parse("zip=98033");
    expect(q.lat).toBeUndefined();
    expect(q.lng).toBeUndefined();
    expect(q.zip).toBe("98033");
  });

  it("accepts zipCode/zipcode aliases", () => {
    expect(parse("zipCode=98033").zip).toBe("98033");
    expect(parse("zipcode=98033").zip).toBe("98033");
  });

  it("keeps coordinates when both coords and zip are present (coords win)", () => {
    const q = parse("lat=47.68&lng=-122.21&zip=98033");
    expect(q.lat).toBe(47.68);
    expect(q.lng).toBe(-122.21);
    expect(q.zip).toBe("98033");
  });
});

describe("parseDirectoryQuery — radius & limit", () => {
  it("defaults radius to 5000 and limit to 50", () => {
    const q = parse("lat=1&lng=2");
    expect(q.radiusM).toBe(5000);
    expect(q.limit).toBe(50);
  });

  it("clamps radius to [100, 50000]", () => {
    expect(parse("lat=1&lng=2&radius=10").radiusM).toBe(100);
    expect(parse("lat=1&lng=2&radius=999999").radiusM).toBe(50000);
    expect(parse("lat=1&lng=2&radius=1234").radiusM).toBe(1234);
  });

  it("accepts radiusM/radius_m aliases", () => {
    expect(parse("lat=1&lng=2&radiusM=2500").radiusM).toBe(2500);
    expect(parse("lat=1&lng=2&radius_m=2500").radiusM).toBe(2500);
  });

  it("clamps limit to [1, 200] and truncates fractions", () => {
    expect(parse("lat=1&lng=2&limit=0").limit).toBe(1);
    expect(parse("lat=1&lng=2&limit=9999").limit).toBe(200);
    expect(parse("lat=1&lng=2&limit=20.9").limit).toBe(20);
  });

  it("falls back to defaults for non-numeric radius/limit", () => {
    const q = parse("lat=1&lng=2&radius=abc&limit=xyz");
    expect(q.radiusM).toBe(5000);
    expect(q.limit).toBe(50);
  });
});

describe("parseDirectoryQuery — verticals", () => {
  it("defaults to all four coordinate verticals", () => {
    expect(parse("lat=1&lng=2").verticals).toEqual(["hotels", "healthcare", "ria", "insurance"]);
  });

  it("accepts a CSV subset, case-insensitively, via vertical/verticals", () => {
    expect(parse("lat=1&lng=2&verticals=hotels,ria").verticals).toEqual(["hotels", "ria"]);
    expect(parse("lat=1&lng=2&verticals=HOTELS, Ria ").verticals).toEqual(["hotels", "ria"]);
    expect(parse("lat=1&lng=2&vertical=insurance").verticals).toEqual(["insurance"]);
  });

  it("warns and excludes social (no coordinates)", () => {
    const q = parse("lat=1&lng=2&verticals=hotels,social");
    expect(q.verticals).toEqual(["hotels"]);
    expect(q.warnings.some((w) => w.includes("social"))).toBe(true);
  });

  it("warns on an unknown vertical and drops it", () => {
    const q = parse("lat=1&lng=2&verticals=hotels,banana");
    expect(q.verticals).toEqual(["hotels"]);
    expect(q.warnings.some((w) => w.includes("banana"))).toBe(true);
  });

  it("warns when no valid verticals remain", () => {
    const q = parse("lat=1&lng=2&verticals=social");
    expect(q.verticals).toEqual([]);
    expect(q.warnings.some((w) => w.includes("no valid verticals"))).toBe(true);
  });

  it("deduplicates repeated verticals", () => {
    expect(parse("lat=1&lng=2&verticals=hotels,hotels,ria").verticals).toEqual(["hotels", "ria"]);
  });
});
