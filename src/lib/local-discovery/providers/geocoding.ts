/* Geocoding provider (Google Geocoding API) for Local Discovery location resolution:
     • forwardGeocode(postal, country) — postal code → coordinates + locality, for NON-US postals (US uses
       the free `zips` centroid table instead).
     • reverseGeocode(lat, lng) — coordinates → city/state/country/postal labels, best-effort.

   Both are PAID calls, so they run through the reliability guard (`guardedCall`) and the spend budget
   (`RequestBudget`): no key, no budget, or an open circuit → return null and the caller degrades. A postal
   forward-geocode yields an APPROXIMATE centroid, so its precision is marked `zip_centroid`, never rooftop
   — the honesty rule that keeps a postal search from ever claiming a 0 m distance. */

import type { GeoPrecision } from "../types";
import { RequestBudget, estimateCost } from "../spend";
import { guardedCall } from "../reliability";

export interface GeocodeResult {
  lat: number;
  lng: number;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode?: string;
  precision: GeoPrecision;
}

const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const PROVIDER_KEY = "google_geocoding";

/** Prefer a dedicated geocoding key; fall back to a general Maps key, then the Places key (same GCP key
 *  works if the Geocoding API is enabled on it). Empty when none configured. */
export function geocodingApiKey(): string {
  return (
    process.env.GEOCODING_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.PLACES_API_KEY ||
    ""
  ).trim();
}

export function hasGeocodingProvider(): boolean {
  return geocodingApiKey().length > 0;
}

interface GAddressComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

interface GResult {
  geometry?: { location?: { lat?: number; lng?: number }; location_type?: string };
  address_components?: GAddressComponent[];
}

interface GResponse {
  status?: string;
  results?: GResult[];
}

function pickComponent(components: GAddressComponent[] | undefined, type: string): GAddressComponent | undefined {
  return components?.find((c) => c.types?.includes(type));
}

function labelsFrom(components: GAddressComponent[] | undefined): {
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode?: string;
} {
  const city = pickComponent(components, "locality") ?? pickComponent(components, "postal_town");
  const state = pickComponent(components, "administrative_area_level_1");
  const postal = pickComponent(components, "postal_code");
  const country = pickComponent(components, "country");
  return {
    city: city?.long_name,
    state: state?.short_name ?? state?.long_name,
    postalCode: postal?.long_name,
    countryCode: country?.short_name?.toUpperCase(),
  };
}

function precisionFrom(locationType: string | undefined, forPostal: boolean): GeoPrecision {
  if (forPostal) return "zip_centroid"; // a postal code is always an area centroid
  return locationType === "ROOFTOP" ? "rooftop" : "approximate";
}

async function callGeocode(params: URLSearchParams, budget: RequestBudget | undefined, deadlineAt?: number): Promise<GResponse | null> {
  const key = geocodingApiKey();
  if (!key) return null;
  const cost = estimateCost("geocoding", 1);
  if (budget && !budget.canSpend(cost)) return null;
  params.set("key", key);

  const timeoutMs = deadlineAt ? Math.max(500, Math.min(2500, deadlineAt - Date.now())) : 2500;
  try {
    const res = await guardedCall(
      PROVIDER_KEY,
      async () => {
        const r = await fetch(`${GEOCODE_ENDPOINT}?${params.toString()}`, {
          headers: { Accept: "application/json" },
        });
        if (!r.ok) throw new Error(`geocoding http ${r.status}`);
        return (await r.json()) as GResponse;
      },
      { timeoutMs, retries: 1 },
    );
    // Bill only on a call that actually reached the provider.
    budget?.spend("geocoding", cost, 1);
    if (res.status && res.status !== "OK") return null;
    return res;
  } catch {
    return null;
  }
}

/** Postal code + country → coordinates + labels. Returns null when unavailable (no key / no result / budget). */
export async function forwardGeocode(
  postalCode: string,
  countryCode: string,
  budget?: RequestBudget,
  deadlineAt?: number,
): Promise<GeocodeResult | null> {
  const cc = countryCode.trim().toUpperCase();
  const postal = postalCode.trim();
  if (!postal || !cc) return null;

  const params = new URLSearchParams({ components: `country:${cc}|postal_code:${postal}` });
  const res = await callGeocode(params, budget, deadlineAt);
  const first = res?.results?.[0];
  const loc = first?.geometry?.location;
  if (!first || typeof loc?.lat !== "number" || typeof loc?.lng !== "number") return null;

  const labels = labelsFrom(first.address_components);
  return {
    lat: loc.lat,
    lng: loc.lng,
    city: labels.city,
    state: labels.state,
    postalCode: labels.postalCode ?? postal,
    countryCode: labels.countryCode ?? cc,
    precision: precisionFrom(first.geometry?.location_type, true),
  };
}

/** Coordinates → city/state/country/postal. Coordinates are already exact, so `lat`/`lng` echo the input. */
export async function reverseGeocode(
  lat: number,
  lng: number,
  budget?: RequestBudget,
  deadlineAt?: number,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    latlng: `${lat},${lng}`,
    result_type: "locality|administrative_area_level_1|country|postal_code",
  });
  const res = await callGeocode(params, budget, deadlineAt);
  const first = res?.results?.[0];
  if (!first) return null;
  const labels = labelsFrom(first.address_components);
  return {
    lat,
    lng,
    city: labels.city,
    state: labels.state,
    postalCode: labels.postalCode,
    countryCode: labels.countryCode,
    precision: "rooftop",
  };
}
