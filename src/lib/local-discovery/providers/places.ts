/* Google Places API (New) client for Local Discovery — a country-aware TypeScript port of the
   hotel-scraper's places-client.mjs, generalized beyond US lodging.

   Key differences from the batch scraper:
   • Proximity-first: default path is Nearby Search (`places:searchNearby`) with a strict circle
     `locationRestriction` + `rankPreference: DISTANCE`; a free-text/specialty refine switches to Text
     Search (`places:searchText`) with a circle `locationBias`, then we post-filter to the radius.
   • ONE fetch = ONE paid call. No internal pagination on the search path (a 20-result page is plenty for a
     feed and keeps per-request cost fixed) — the reliability guard handles timeout/retry/breaker.
   • Budget-gated internally: with a `RequestBudget` it won't call when the per-request cap or daily budget
     is exhausted; it records spend only on a call that actually reached Google.
   • ToS: the field mask stores only permitted fields + the stable `place_id`. Photo resource NAMES ride
     along free as a "has photos" signal only — they are NOT cacheable and are re-resolved at view time. */

import type { RequestBudget } from "../spend";
import { estimateCost } from "../spend";
import { guardedCall } from "../reliability";

const SEARCH_TEXT_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const SEARCH_NEARBY_ENDPOINT = "https://places.googleapis.com/v1/places:searchNearby";
const DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const PROVIDER_KEY = "google_places";

/** Fields billed at (at most) the Enterprise SKU — rating/priceLevel/openingHours. Deliberately EXCLUDES
 *  Atmosphere-tier fields (reviews, editorialSummary): those are fetched at view time for a single entity. */
export const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.types",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.businessStatus",
  "places.regularOpeningHours",
  "places.currentOpeningHours",
  "places.photos",
  // NOTE: no `nextPageToken` — it is REJECTED by places:searchNearby (HTTP 400 INVALID_ARGUMENT),
  // which is our default path, and we never paginate the search path anyway (see header comment).
  // Only places:searchText accepts it; add a Text-only mask if pagination is ever introduced.
].join(",");

export function placesApiKey(): string {
  return (process.env.PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "").trim();
}

export function hasPlacesProvider(): boolean {
  return placesApiKey().length > 0;
}

export interface PlacesSearchInput {
  lat: number;
  lng: number;
  radiusMeters: number;
  /** Place types (e.g. ["lodging"] or ["hospital","doctor"]). */
  includedTypes: string[];
  /** Free-text refine / specialty — switches to Text Search when present. */
  textQuery?: string;
  /** ISO country for regionCode biasing. */
  regionCode?: string;
  maxResults?: number;
  languageCode?: string;
  openNow?: boolean;
  minRating?: number;
  deadlineAt?: number;
}

export interface PlaceResult {
  id: string;
  name: string;
  formattedAddress?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode?: string;
  lat?: number;
  lng?: number;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  phone?: string;
  website?: string;
  googleMapsUri?: string;
  types?: string[];
  primaryType?: string;
  primaryTypeDisplayName?: string;
  businessStatus?: string;
  openNow?: boolean;
  weekdayText?: string[];
  hasPhotos: boolean;
  /** First photo resource name — used ONLY to resolve a fresh media URL at view time (never persisted). */
  photoName?: string;
}

export interface PlacesSearchOutput {
  results: PlaceResult[];
  calls: number;
  /** Set when nothing was called: "no_key" (unconfigured), "budget" (gated), or "error" (guard threw). */
  skipped?: "no_key" | "budget" | "error";
}

interface RawAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: RawAddressComponent[];
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  types?: string[];
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  businessStatus?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[]; openNow?: boolean };
  currentOpeningHours?: { openNow?: boolean };
  photos?: Array<{ name?: string }>;
}

function componentFor(components: RawAddressComponent[] | undefined, type: string): RawAddressComponent | undefined {
  return components?.find((c) => c.types?.includes(type));
}

function mapPlace(raw: RawPlace): PlaceResult | null {
  if (!raw.id || !raw.displayName?.text) return null;
  const comps = raw.addressComponents;
  const city = componentFor(comps, "locality") ?? componentFor(comps, "postal_town");
  const state = componentFor(comps, "administrative_area_level_1");
  const postal = componentFor(comps, "postal_code");
  const country = componentFor(comps, "country");
  const openNow = raw.currentOpeningHours?.openNow ?? raw.regularOpeningHours?.openNow;
  return {
    id: raw.id,
    name: raw.displayName.text,
    formattedAddress: raw.formattedAddress,
    city: city?.longText,
    state: state?.shortText ?? state?.longText,
    postalCode: postal?.longText,
    countryCode: country?.shortText?.toUpperCase(),
    lat: raw.location?.latitude,
    lng: raw.location?.longitude,
    rating: typeof raw.rating === "number" ? raw.rating : undefined,
    userRatingCount: typeof raw.userRatingCount === "number" ? raw.userRatingCount : undefined,
    priceLevel: raw.priceLevel,
    phone: raw.nationalPhoneNumber ?? raw.internationalPhoneNumber,
    website: raw.websiteUri,
    googleMapsUri: raw.googleMapsUri,
    types: raw.types,
    primaryType: raw.primaryType,
    primaryTypeDisplayName: raw.primaryTypeDisplayName?.text,
    businessStatus: raw.businessStatus,
    openNow,
    weekdayText: raw.regularOpeningHours?.weekdayDescriptions,
    hasPhotos: Array.isArray(raw.photos) && raw.photos.length > 0,
    photoName: raw.photos?.[0]?.name,
  };
}

function buildBody(input: PlacesSearchInput): { endpoint: string; body: Record<string, unknown> } {
  const maxResults = Math.max(1, Math.min(20, input.maxResults ?? 20));
  const radius = Math.max(1, Math.min(50000, Math.round(input.radiusMeters)));
  const center = { latitude: input.lat, longitude: input.lng };

  if (input.textQuery && input.textQuery.trim()) {
    // Text Search: free-text refine, circle bias, then radius post-filter.
    const body: Record<string, unknown> = {
      textQuery: input.textQuery.trim(),
      pageSize: maxResults,
      languageCode: input.languageCode ?? "en",
      locationBias: { circle: { center, radius } },
    };
    if (input.includedTypes.length === 1) body.includedType = input.includedTypes[0];
    if (input.regionCode) body.regionCode = input.regionCode;
    // NOTE: deliberately NOT setting server-side `openNow` — Google hard-drops places whose hours it
    // doesn't publish (most lodging, many clinics), which empties the feed. We fetch all candidates and
    // apply a lenient open-now filter below (keep open + unknown, drop only known-closed).
    if (typeof input.minRating === "number") body.minRating = input.minRating;
    return { endpoint: SEARCH_TEXT_ENDPOINT, body };
  }

  // Nearby Search: strict circle restriction, ranked by distance.
  const body: Record<string, unknown> = {
    includedTypes: input.includedTypes,
    maxResultCount: maxResults,
    languageCode: input.languageCode ?? "en",
    rankPreference: "DISTANCE",
    locationRestriction: { circle: { center, radius } },
  };
  if (input.regionCode) body.regionCode = input.regionCode;
  return { endpoint: SEARCH_NEARBY_ENDPOINT, body };
}

/** Run one Places search (Nearby by default, Text when refining). Budget-gated + guarded; returns an empty
 *  result with a `skipped` reason rather than throwing so a caller can degrade to seed/cache. */
export async function searchPlaces(input: PlacesSearchInput, budget?: RequestBudget): Promise<PlacesSearchOutput> {
  const key = placesApiKey();
  if (!key) return { results: [], calls: 0, skipped: "no_key" };

  const cost = estimateCost("google_places_search", 1);
  if (budget && !budget.canSpend(cost)) return { results: [], calls: 0, skipped: "budget" };

  const { endpoint, body } = buildBody(input);
  const timeoutMs = input.deadlineAt ? Math.max(600, Math.min(3000, input.deadlineAt - Date.now())) : 3000;

  let raw: { places?: RawPlace[] } | null = null;
  try {
    raw = await guardedCall(
      PROVIDER_KEY,
      async () => {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": SEARCH_FIELD_MASK,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new Error(`Places HTTP ${res.status}: ${text.slice(0, 200)}`);
          // 429 / quota should retry; 4xx config errors should not.
          (err as Error & { retryable?: boolean }).retryable =
            res.status === 429 || /RESOURCE_EXHAUSTED/i.test(text) || res.status >= 500;
          throw err;
        }
        return (await res.json()) as { places?: RawPlace[] };
      },
      {
        timeoutMs,
        retries: 1,
        shouldRetry: (e) => (e as Error & { retryable?: boolean })?.retryable !== false,
      },
    );
  } catch {
    return { results: [], calls: 0, skipped: "error" };
  }

  // Bill the (successful) call.
  budget?.spend("google_places_search", cost, 1);

  let results = (raw?.places ?? []).map(mapPlace).filter((p): p is PlaceResult => p !== null);

  // Post-filters the New API doesn't apply server-side on every path.
  if (input.textQuery) {
    const { haversineMeters } = await import("../location");
    results = results.filter(
      (p) => p.lat == null || p.lng == null || haversineMeters(input.lat, input.lng, p.lat, p.lng) <= input.radiusMeters,
    );
  }
  if (typeof input.minRating === "number") {
    results = results.filter((p) => (p.rating ?? 0) >= input.minRating!);
  }
  if (input.openNow) {
    results = results.filter((p) => p.openNow !== false);
  }

  return { results, calls: 1 };
}

// ---------------------------------------------------------------------------
// View-time helpers (single entity) — used by the entity detail path, not search.
// ---------------------------------------------------------------------------

/** Fetch a fresh photo media URL for a single place at view time. Photo names are NOT cacheable (ToS), so
 *  this re-derives the current name via Place Details (free IDs-only) then resolves media (paid). */
export async function resolvePlacePhoto(
  placeId: string,
  opts: { maxWidthPx?: number; budget?: RequestBudget; deadlineAt?: number } = {},
): Promise<string | null> {
  const key = placesApiKey();
  if (!key || !placeId) return null;
  const timeoutMs = opts.deadlineAt ? Math.max(600, Math.min(3000, opts.deadlineAt - Date.now())) : 3000;

  // 1) Place Details (IDs-only, free) → current photo resource name.
  let photoName: string | null = null;
  try {
    photoName = await guardedCall(
      PROVIDER_KEY,
      async () => {
        const res = await fetch(`${DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`, {
          headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "photos" },
        });
        if (!res.ok) throw new Error(`Place Details HTTP ${res.status}`);
        const data = (await res.json()) as { photos?: Array<{ name?: string }> };
        return data.photos?.[0]?.name ?? null;
      },
      { timeoutMs, retries: 1 },
    );
  } catch {
    return null;
  }
  if (!photoName) return null;

  // 2) Place Photo media (paid) → resolved URL.
  const cost = estimateCost("google_places_photo", 1);
  if (opts.budget && !opts.budget.canSpend(cost)) return null;
  const w = Math.max(1, Math.min(4800, Math.round(opts.maxWidthPx ?? 1200)));
  try {
    const uri = await guardedCall(
      PROVIDER_KEY,
      async () => {
        const res = await fetch(
          `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${w}&skipHttpRedirect=true`,
          { headers: { "X-Goog-Api-Key": key } },
        );
        if (!res.ok) throw new Error(`Place Photo HTTP ${res.status}`);
        const data = (await res.json()) as { photoUri?: string };
        return data.photoUri ?? null;
      },
      { timeoutMs, retries: 1 },
    );
    if (uri) opts.budget?.spend("google_places_photo", cost, 1);
    return uri;
  } catch {
    return null;
  }
}
