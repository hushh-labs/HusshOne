/* Location resolution for Local Discovery. Accepts EITHER raw coordinates OR postalCode+countryCode and
   produces a single `ResolvedLocation` the orchestrator hands to every adapter.

   Honesty rules enforced here (deliverable #1):
   • A postal code resolves to an AREA CENTROID, never a rooftop point → `approximateOrigin: true`,
     `precision: "zip_centroid"`. Distances measured from it are therefore approximate.
   • US postals use the free `zips` centroid table (with city/state); other countries use the paid
     geocoding provider, which is budget-gated and degrades to a clear error if unavailable.
   • On the coordinates path we only spend a reverse-geocode call when the client did NOT supply a country
     (country is required to pick country-specific adapters); otherwise we trust the client and stay free.
   • `haversineMeters` + `honestDistanceMeters` give callers a distance that is never a misleading 0 m when
     either endpoint is an approximate centroid. */

import { getDirectoryPool } from "@/lib/directory/db";
import { V1InputError } from "@/lib/api/v1-input";
import type { CountryCode, GeoPrecision } from "./types";
import { RequestBudget } from "./spend";
import { forwardGeocode, hasGeocodingProvider, reverseGeocode } from "./providers/geocoding";

export const DEFAULT_RADIUS_M = 5000;
export const MIN_RADIUS_M = 100;
export const MAX_RADIUS_M = 50000;

export interface LocationInput {
  latitude?: number | string | null;
  longitude?: number | string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  radiusMeters?: number | string | null;
}

export interface ResolvedLocation {
  lat: number;
  lng: number;
  radiusMeters: number;
  /** ISO 3166-1 alpha-2 uppercased; "" when it could not be determined. */
  countryCode: CountryCode;
  city?: string;
  state?: string;
  postalCode?: string;
  /** True when the origin is an area centroid → all distances from it are approximate. */
  approximateOrigin: boolean;
  precision: GeoPrecision;
  resolvedFrom: "coordinates" | "postal";
  warnings: string[];
}

export function clampRadiusMeters(raw: LocationInput["radiusMeters"]): number {
  if (raw == null || raw === "") return DEFAULT_RADIUS_M;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RADIUS_M;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(n)));
}

function validCoord(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Great-circle distance in metres. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Distance that never claims false precision: when either endpoint is an approximate centroid, a
 *  sub-`floorM` result is lifted to `floorM` so the UI never renders a misleading "0 m". */
export function honestDistanceMeters(raw: number, approximate: boolean, floorM = 250): number {
  const d = Math.max(0, Math.round(raw));
  if (approximate && d < floorM) return floorM;
  return d;
}

/** US ZIP → centroid + city/state from the free GeoNames `zips` table. Null when DB/creds absent or unknown. */
async function usZipCentroid(
  postalCode: string,
): Promise<{ lat: number; lng: number; city?: string; state?: string; postalCode: string } | null> {
  const pool = getDirectoryPool("hotels");
  if (!pool) return null;
  const digits = postalCode.replace(/[^0-9]/g, "").slice(0, 5).padStart(5, "0");
  try {
    const { rows } = await pool.query(
      "SELECT lat, lng, city, state FROM zips WHERE zip = $1 AND lat IS NOT NULL AND lng IS NOT NULL LIMIT 1",
      [digits],
    );
    if (!rows.length) return null;
    const lat = Number(rows[0].lat);
    const lng = Number(rows[0].lng);
    if (!validCoord(lat, lng)) return null;
    return {
      lat,
      lng,
      city: rows[0].city ?? undefined,
      state: rows[0].state ?? undefined,
      postalCode: digits,
    };
  } catch {
    return null;
  }
}

/** Resolve a location from coordinates or postalCode+countryCode. Throws `V1InputError` on invalid/missing
 *  input; degrades (with warnings) rather than throwing when only enrichment labels are unavailable. */
export async function resolveLocation(
  input: LocationInput,
  budget?: RequestBudget,
  deadlineAt?: number,
): Promise<ResolvedLocation> {
  const warnings: string[] = [];
  const radiusMeters = clampRadiusMeters(input.radiusMeters);

  const hasCoords = input.latitude != null && input.longitude != null && input.latitude !== "" && input.longitude !== "";
  const postalCode = (input.postalCode ?? "").toString().trim();
  const providedCountry = (input.countryCode ?? "").toString().trim().toUpperCase();
  const hasPostal = postalCode.length > 0 && providedCountry.length > 0;

  // ---- Coordinates path (rooftop, exact) ----
  if (hasCoords) {
    const lat = Number(input.latitude);
    const lng = Number(input.longitude);
    if (!validCoord(lat, lng)) {
      throw new V1InputError("latitude/longitude are out of range", 400, "bad_coordinates");
    }
    let countryCode = providedCountry;
    let city: string | undefined;
    let state: string | undefined;
    let resolvedPostal: string | undefined;

    // Only spend a reverse-geocode when we must (country unknown) — country drives adapter selection.
    if (!countryCode && hasGeocodingProvider()) {
      const rev = await reverseGeocode(lat, lng, budget, deadlineAt);
      if (rev) {
        countryCode = rev.countryCode ?? "";
        city = rev.city;
        state = rev.state;
        resolvedPostal = rev.postalCode;
      }
    }
    if (!countryCode) {
      warnings.push("country could not be determined from coordinates; country-specific sources may be skipped");
    }
    return {
      lat,
      lng,
      radiusMeters,
      countryCode,
      city,
      state,
      postalCode: resolvedPostal,
      approximateOrigin: false,
      precision: "rooftop",
      resolvedFrom: "coordinates",
      warnings,
    };
  }

  // ---- Postal path (area centroid, approximate) ----
  if (hasPostal) {
    if (providedCountry === "US") {
      const z = await usZipCentroid(postalCode);
      if (z) {
        return {
          lat: z.lat,
          lng: z.lng,
          radiusMeters,
          countryCode: "US",
          city: z.city,
          state: z.state,
          postalCode: z.postalCode,
          approximateOrigin: true,
          precision: "zip_centroid",
          resolvedFrom: "postal",
          warnings,
        };
      }
      // Fall through to the provider if the ZIP isn't in our table.
    }

    const geo = await forwardGeocode(postalCode, providedCountry, budget, deadlineAt);
    if (geo) {
      return {
        lat: geo.lat,
        lng: geo.lng,
        radiusMeters,
        countryCode: geo.countryCode ?? providedCountry,
        city: geo.city,
        state: geo.state,
        postalCode: geo.postalCode ?? postalCode,
        approximateOrigin: true,
        precision: geo.precision,
        resolvedFrom: "postal",
        warnings,
      };
    }

    const reason = hasGeocodingProvider()
      ? `could not resolve postal code ${postalCode} (${providedCountry})`
      : `postal-code lookup for ${providedCountry} needs a geocoding key; send latitude/longitude instead`;
    throw new V1InputError(reason, 422, "postal_unresolved");
  }

  throw new V1InputError("provide latitude+longitude or postalCode+countryCode", 400, "missing_location");
}
