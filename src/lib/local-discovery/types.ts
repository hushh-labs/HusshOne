/* Shared contracts for the real-time Local Discovery feed (POST /api/local-discovery/search + its SSE
   stream). Everything downstream — location resolution, providers, adapters, normalization, dedupe,
   quality scoring, ranking, orchestration, and the frontend — speaks these types.

   Design rules baked into the contract:
   • Every adapter returns the SAME normalized `UnifiedProfile`, whatever the category or country.
   • Internal ids are NAMESPACED (`${category}:${scopedId}`) so ids never collide across categories.
   • Every profile keeps `externalIds` (source-scoped ids), `sources` (attribution), and `provenance`
     (which source supplied each winning field) — so a merged record is always traceable.
   • Location honesty: `approximateLocation`/`distanceApproximate` mark postal-centroid-derived geo so the
     UI never renders a misleading exact "0 m". */

import type { RequestBudget } from "./spend";

// ---------------------------------------------------------------------------
// Categories & geography
// ---------------------------------------------------------------------------

/** Real-time categories. Extend here as new adapters land — each one needs an entry in `ADAPTERS`
 *  (adapters/index.ts), a branch in `directoryRowToProfile` (normalize.ts), and a UI label. */
export type DiscoveryCategory = "hotels" | "healthcare" | "ria" | "insurance";

export const DISCOVERY_CATEGORIES: readonly DiscoveryCategory[] = [
  "hotels",
  "healthcare",
  "ria",
  "insurance",
] as const;

/** ISO 3166-1 alpha-2, uppercased (e.g. "US", "IN"). Kept as a widened string for forward-compat. */
export type CountryCode = string;

/** Coordinate precision. `approximate` == derived from a postal/area centroid, not a real address. */
export type GeoPrecision = "rooftop" | "zip_centroid" | "approximate";

export interface GeoPoint {
  lat: number;
  lng: number;
  precision: GeoPrecision;
}

// ---------------------------------------------------------------------------
// Source attribution & provenance
// ---------------------------------------------------------------------------

/** Where a datum originated. `directory` = our own seeded PostGIS directory (verification/fallback);
 *  `registry` = an authoritative public registry (NPPES, SEC, state DOI); the rest are live providers. */
export type SourceKind =
  | "directory"
  | "registry"
  | "google_places"
  | "grounded_web"
  | "osm"
  | "user_input";

export interface SourceAttribution {
  kind: SourceKind;
  /** Human-facing label, e.g. "Google Places", "NPPES", "SEC IAPD". */
  label: string;
  /** Stable id in that source's own namespace, when known (place_id, NPI, CRD, …). */
  externalId?: string;
  /** ISO-8601 fetch time for this contribution. */
  fetchedAt?: string;
  /** Citation URL — set for grounded-web enrichment (required for display). */
  url?: string;
}

// ---------------------------------------------------------------------------
// Unified profile (the one shape every adapter returns)
// ---------------------------------------------------------------------------

/** Measurable quality bucket. `insufficient` records are hidden/heavily down-ranked unless nothing
 *  better exists — a name + postal code alone must never present as a complete profile. */
export type ProfileQuality = "rich" | "standard" | "basic" | "insufficient";

export interface DiscoveryReview {
  author?: string;
  rating?: number;
  text?: string;
  publishedAt?: string;
  /** Mandatory author attribution when the review comes from Google Places. */
  attribution?: string;
}

export interface OpeningHours {
  /** Human weekday lines, e.g. ["Monday: 9:00 AM – 5:00 PM", …]. */
  weekdayText?: string[];
  openNow?: boolean;
}

/** The normalized profile. Descriptive fields are optional (a seed row may only have a name + address);
 *  `quality`/`qualityScore` classify how complete it actually is. */
export interface UnifiedProfile {
  /** Namespaced stable internal id: `${category}:${scopedId}` (scopedId is the primary source id). */
  id: string;
  category: DiscoveryCategory;
  subcategory?: string;

  name: string;
  /** Short one-liner for cards (e.g. "Cardiology · MD" or "4.6★ · 320 reviews"). */
  headline?: string;
  description?: string;
  /** Resolved image URL. For Google Places this is fetched at view time and NOT persisted (ToS). */
  imageUrl?: string;

  rating?: number;
  reviewCount?: number;
  reviews?: DiscoveryReview[];

  phone?: string;
  website?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode?: CountryCode;

  location?: GeoPoint;
  /** Great-circle distance from the search point, in metres. */
  distanceMeters?: number;
  /** True when distance is derived from an approximate (centroid) origin or profile location. */
  distanceApproximate: boolean;

  openingHours?: OpeningHours;
  services?: string[];
  /** Licences / registrations / board certifications. */
  credentials?: string[];

  /** Source-scoped external ids, keyed by a stable slug: { google_places, npi, crd, osm, dedup }. */
  externalIds: Record<string, string>;
  /** All contributing sources (for display attribution). */
  sources: SourceAttribution[];
  /** Per-field provenance: field name → the source kind that supplied the winning value. */
  provenance: Record<string, SourceKind>;

  qualityScore: number; // 0..100
  quality: ProfileQuality;

  /** ISO fetch time of the assembled record. */
  fetchedAt: string;
  /** ISO expiry (provider-aware TTL) after which the entity cache entry is stale. */
  expiresAt?: string;
  /** True when the location is a centroid rather than a real address. */
  approximateLocation: boolean;
}

// ---------------------------------------------------------------------------
// Query / filters / sorting
// ---------------------------------------------------------------------------

export type SortOrder = "recommended" | "nearest" | "rating" | "reviews";

export const SORT_ORDERS: readonly SortOrder[] = ["recommended", "nearest", "rating", "reviews"] as const;

export interface DiscoveryFilters {
  minRating?: number;
  openNow?: boolean;
  /** Free-text refinement passed to live providers (e.g. "boutique", "pediatric"). */
  query?: string;
  /** Restrict to these subcategories/specialties when supported. */
  subcategories?: string[];
}

/** The search after location resolution — echoed back to the client and used to build cache keys. */
export interface ResolvedQuery {
  lat: number;
  lng: number;
  radiusMeters: number;
  countryCode: CountryCode;
  city?: string;
  state?: string;
  postalCode?: string;
  /** True when the search ORIGIN came from a postal centroid (distances are approximate). */
  approximateOrigin: boolean;
  categories: DiscoveryCategory[];
  limit: number;
  sort: SortOrder;
  filters: DiscoveryFilters;
  resolvedFrom: "coordinates" | "postal";
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/** Everything an adapter needs to run one category's search. Built by the orchestrator per request. */
export interface DiscoverySearchContext {
  lat: number;
  lng: number;
  radiusMeters: number;
  countryCode: CountryCode;
  city?: string;
  state?: string;
  postalCode?: string;
  /** True when the origin is a postal centroid → adapters mark their distances approximate. */
  approximateOrigin: boolean;
  limit: number;
  filters: DiscoveryFilters;
  /** When false the adapter must stay on seed/cache data only (budget exhausted or paid APIs off). */
  allowPaid: boolean;
  /** Shared per-request paid-call budget (one instance across all categories). Absent → no paid calls. */
  budget?: RequestBudget;
  /** Epoch-ms wall-clock deadline the adapter must respect (soft — return what it has). */
  deadlineAt: number;
}

export interface DiscoveryAdapterResult {
  category: DiscoveryCategory;
  profiles: UnifiedProfile[];
  /** Non-fatal notes (provider degraded, budget hit, no live coverage for country, …). */
  warnings: string[];
  /** Which source kinds actually contributed to this result. */
  sourcesUsed: SourceKind[];
  /** True when the adapter fell back to seed/cache only (no live enrichment happened). */
  degraded: boolean;
}

/** A country-aware category adapter. `supportedCountries` = "all" or an explicit allow-list so a US-only
 *  registry is never used for an Indian search. */
export interface LocalDiscoveryAdapter {
  readonly category: DiscoveryCategory;
  readonly supportedCountries: readonly CountryCode[] | "all";
  search(ctx: DiscoverySearchContext): Promise<DiscoveryAdapterResult>;
}

// ---------------------------------------------------------------------------
// Progressive SSE events
// ---------------------------------------------------------------------------

/** Category-level progress state for the client's independent loading indicators. */
export type CategoryStatus = "pending" | "loading" | "done" | "error" | "degraded";

/** The event envelope streamed over SSE. Each category resolves independently; `search_complete` carries
 *  the final merged + ranked list so the client can settle on an authoritative order. */
export type DiscoveryEvent =
  | { type: "search_started"; searchId: string; query: ResolvedQuery }
  | { type: "category_started"; category: DiscoveryCategory }
  | {
      type: "category_results";
      category: DiscoveryCategory;
      profiles: UnifiedProfile[];
      status: CategoryStatus;
      warnings: string[];
    }
  | { type: "category_error"; category: DiscoveryCategory; error: string }
  | { type: "search_complete"; count: number; results: UnifiedProfile[]; warnings: string[] };
