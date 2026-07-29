import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  getPool: vi.fn(),
  forwardGeocode: vi.fn(),
  reverseGeocode: vi.fn(),
  hasGeocodingProvider: vi.fn(),
}));

vi.mock("@/lib/directory/db", () => ({
  getDirectoryPool: h.getPool,
}));
vi.mock("./providers/geocoding", () => ({
  forwardGeocode: h.forwardGeocode,
  reverseGeocode: h.reverseGeocode,
  hasGeocodingProvider: h.hasGeocodingProvider,
}));

import { V1InputError } from "@/lib/api/v1-input";
import {
  clampRadiusMeters,
  haversineMeters,
  honestDistanceMeters,
  resolveLocation,
} from "./location";

describe("local-discovery/location", () => {
  beforeEach(() => {
    h.query.mockReset();
    h.getPool.mockReset().mockReturnValue({ query: h.query });
    h.forwardGeocode.mockReset().mockResolvedValue(null);
    h.reverseGeocode.mockReset().mockResolvedValue(null);
    h.hasGeocodingProvider.mockReset().mockReturnValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  describe("clampRadiusMeters", () => {
    it("defaults and clamps", () => {
      expect(clampRadiusMeters(null)).toBe(5000);
      expect(clampRadiusMeters("abc")).toBe(5000);
      expect(clampRadiusMeters(10)).toBe(100);
      expect(clampRadiusMeters(999999)).toBe(50000);
      expect(clampRadiusMeters(3000)).toBe(3000);
    });
  });

  describe("haversineMeters", () => {
    it("is ~0 for the same point and positive across distance", () => {
      expect(haversineMeters(47.68, -122.21, 47.68, -122.21)).toBeCloseTo(0, 3);
      expect(haversineMeters(47.6, -122.3, 47.7, -122.2)).toBeGreaterThan(1000);
    });
  });

  describe("honestDistanceMeters", () => {
    it("never returns a misleading 0 m when approximate", () => {
      expect(honestDistanceMeters(3, true)).toBe(250);
      expect(honestDistanceMeters(0, true)).toBe(250);
      expect(honestDistanceMeters(3, false)).toBe(3);
      expect(honestDistanceMeters(5000, true)).toBe(5000);
    });
  });

  describe("resolveLocation — coordinates", () => {
    it("resolves rooftop coords, trusts a provided country (no paid call)", async () => {
      const r = await resolveLocation({ latitude: 47.68, longitude: -122.21, countryCode: "us" });
      expect(r.resolvedFrom).toBe("coordinates");
      expect(r.approximateOrigin).toBe(false);
      expect(r.precision).toBe("rooftop");
      expect(r.countryCode).toBe("US");
      expect(h.reverseGeocode).not.toHaveBeenCalled();
    });

    it("reverse-geocodes for country when none provided and a provider exists", async () => {
      h.hasGeocodingProvider.mockReturnValue(true);
      h.reverseGeocode.mockResolvedValue({ lat: 12.97, lng: 77.59, city: "Bengaluru", state: "KA", countryCode: "IN", precision: "rooftop" });
      const r = await resolveLocation({ latitude: 12.97, longitude: 77.59 });
      expect(r.countryCode).toBe("IN");
      expect(r.city).toBe("Bengaluru");
      expect(h.reverseGeocode).toHaveBeenCalledOnce();
    });

    it("warns when country is undeterminable", async () => {
      const r = await resolveLocation({ latitude: 47.68, longitude: -122.21 });
      expect(r.countryCode).toBe("");
      expect(r.warnings.join(" ")).toMatch(/country could not be determined/);
    });

    it("rejects out-of-range coordinates", async () => {
      await expect(resolveLocation({ latitude: 999, longitude: -122 })).rejects.toBeInstanceOf(V1InputError);
    });
  });

  describe("resolveLocation — postal", () => {
    it("uses the free US zips centroid and marks the origin approximate", async () => {
      h.query.mockResolvedValue({ rows: [{ lat: 47.68, lng: -122.21, city: "Kirkland", state: "WA" }] });
      const r = await resolveLocation({ postalCode: "98033", countryCode: "US" });
      expect(r.resolvedFrom).toBe("postal");
      expect(r.approximateOrigin).toBe(true);
      expect(r.precision).toBe("zip_centroid");
      expect(r.city).toBe("Kirkland");
      expect(r.lat).toBe(47.68);
      expect(h.forwardGeocode).not.toHaveBeenCalled();
    });

    it("falls back to the provider for a non-US postal", async () => {
      h.forwardGeocode.mockResolvedValue({ lat: 12.97, lng: 77.59, city: "Bengaluru", state: "KA", postalCode: "560001", countryCode: "IN", precision: "zip_centroid" });
      const r = await resolveLocation({ postalCode: "560001", countryCode: "IN" });
      expect(r.approximateOrigin).toBe(true);
      expect(r.countryCode).toBe("IN");
      expect(r.lat).toBe(12.97);
    });

    it("throws postal_unresolved when nothing can resolve it", async () => {
      h.query.mockResolvedValue({ rows: [] });
      await expect(resolveLocation({ postalCode: "00000", countryCode: "US" })).rejects.toMatchObject({
        code: "postal_unresolved",
      });
    });
  });

  it("throws missing_location when neither coords nor postal are given", async () => {
    await expect(resolveLocation({})).rejects.toMatchObject({ code: "missing_location" });
  });
});
