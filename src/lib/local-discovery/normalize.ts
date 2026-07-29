/* Normalization (deliverable #4): turn each raw source into the ONE `UnifiedProfile` shape.

   Two entry points for Phase 1:
   • placeToProfile     — Google Places (New) result → profile (rooftop location, view-time image).
   • directoryRowToProfile — our seeded PostGIS directory row → profile (hotels rooftop; healthcare a
     ZIP centroid, so `approximateLocation`/`distanceApproximate` are true and distance is floored so the
     UI never shows a misleading "0 m").

   Every profile carries namespaced ids, per-field `provenance`, `sources` attribution, and a quality score.
   Photo availability is recorded as `provenance.imageUrl` (a signal); the actual media URL is resolved at
   view time (Google ToS — photo names are not cacheable). */

import type { DirectoryRow } from "@/lib/directory/query";
import type {
  DiscoveryCategory,
  DiscoverySearchContext,
  GeoPoint,
  SourceAttribution,
  SourceKind,
  UnifiedProfile,
} from "./types";
import type { PlaceResult } from "./providers/places";
import { haversineMeters, honestDistanceMeters } from "./location";
import { withQuality } from "./quality";

export function nowIso(): string {
  return new Date().toISOString();
}

/** Provider-aware entity TTL → `expiresAt`. Google snapshots go stale fast; our own directory/registry
 *  data is stable for longer. */
export function expiresAtFor(kind: SourceKind, from = Date.now()): string {
  const minutes =
    kind === "google_places" ? 10 : kind === "grounded_web" ? 60 : /* directory | registry | osm */ 360;
  return new Date(from + minutes * 60_000).toISOString();
}

function distanceFor(
  ctx: DiscoverySearchContext,
  lat: number | null | undefined,
  lng: number | null | undefined,
  approximate: boolean,
): { distanceMeters?: number; distanceApproximate: boolean } {
  if (lat == null || lng == null) return { distanceApproximate: approximate };
  const raw = haversineMeters(ctx.lat, ctx.lng, lat, lng);
  return { distanceMeters: honestDistanceMeters(raw, approximate), distanceApproximate: approximate };
}

/** Google Places (New) result → UnifiedProfile. */
export function placeToProfile(
  place: PlaceResult,
  ctx: DiscoverySearchContext,
  category: DiscoveryCategory,
  subcategory?: string,
): UnifiedProfile {
  const fetchedAt = nowIso();
  const hasCoords = typeof place.lat === "number" && typeof place.lng === "number";
  const location: GeoPoint | undefined = hasCoords
    ? { lat: place.lat!, lng: place.lng!, precision: "rooftop" }
    : undefined;

  // A Places location is rooftop; only an approximate ORIGIN makes the distance approximate.
  const { distanceMeters, distanceApproximate } = distanceFor(ctx, place.lat, place.lng, ctx.approximateOrigin);

  const source: SourceAttribution = {
    kind: "google_places",
    label: "Google Places",
    externalId: place.id,
    fetchedAt,
  };

  const provenance: Record<string, SourceKind> = { name: "google_places" };
  if (place.formattedAddress) provenance.address = "google_places";
  if (location) provenance.location = "google_places";
  if (typeof place.rating === "number") provenance.rating = "google_places";
  if (place.phone) provenance.phone = "google_places";
  if (place.website) provenance.website = "google_places";
  if (place.weekdayText?.length || typeof place.openNow === "boolean") provenance.openingHours = "google_places";
  if (place.hasPhotos) provenance.imageUrl = "google_places"; // media resolved at view time

  const headlineBits: string[] = [];
  if (place.primaryTypeDisplayName) headlineBits.push(place.primaryTypeDisplayName);
  if (typeof place.rating === "number") {
    headlineBits.push(`${place.rating.toFixed(1)}★${place.userRatingCount ? ` · ${place.userRatingCount}` : ""}`);
  }

  return withQuality({
    id: `${category}:${place.id}`,
    category,
    subcategory: subcategory ?? place.primaryTypeDisplayName ?? place.primaryType,
    name: place.name,
    headline: headlineBits.join(" · ") || undefined,
    imageUrl: undefined,
    rating: place.rating,
    reviewCount: place.userRatingCount,
    phone: place.phone,
    website: place.website,
    address: place.formattedAddress,
    city: place.city,
    state: place.state,
    postalCode: place.postalCode,
    countryCode: place.countryCode ?? (ctx.countryCode || undefined),
    location,
    distanceMeters,
    distanceApproximate,
    openingHours:
      place.weekdayText?.length || typeof place.openNow === "boolean"
        ? { weekdayText: place.weekdayText, openNow: place.openNow }
        : undefined,
    externalIds: { google_places: place.id },
    sources: [source],
    provenance,
    qualityScore: 0,
    quality: "insufficient",
    fetchedAt,
    expiresAt: expiresAtFor("google_places", Date.parse(fetchedAt)),
    approximateLocation: false,
  });
}

function fieldStr(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key];
  return v == null || v === "" ? undefined : String(v);
}
function fieldNum(fields: Record<string, unknown>, key: string): number | undefined {
  const v = fields[key];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Seeded PostGIS directory row → UnifiedProfile. Attribution reflects the row's real provenance:
 *  hotels come from our crawler (Places/OSM) → `directory`; healthcare mirrors NPPES → `registry`. */
export function directoryRowToProfile(
  row: DirectoryRow,
  ctx: DiscoverySearchContext,
  category: DiscoveryCategory,
): UnifiedProfile {
  const fetchedAt = nowIso();
  const approximateLocation = row.geoPrecision === "zip_centroid";
  const location: GeoPoint | undefined =
    row.lat != null && row.lng != null
      ? { lat: row.lat, lng: row.lng, precision: row.geoPrecision }
      : undefined;
  const distApproximate = approximateLocation || ctx.approximateOrigin;
  const { distanceMeters, distanceApproximate } = distanceFor(ctx, row.lat, row.lng, distApproximate);

  const f = row.fields;

  if (category === "hotels") {
    const source: SourceAttribution = {
      kind: "directory",
      label: "Hushh Directory",
      externalId: row.id,
      fetchedAt,
    };
    const provenance: Record<string, SourceKind> = { name: "directory" };
    const address = fieldStr(f, "address");
    const phone = fieldStr(f, "phone");
    const website = fieldStr(f, "website");
    const rating = fieldNum(f, "rating");
    const photosCount = fieldNum(f, "photosCount");
    if (address) provenance.address = "directory";
    if (phone) provenance.phone = "directory";
    if (website) provenance.website = "directory";
    if (location) provenance.location = "directory";
    if (typeof rating === "number") provenance.rating = "directory";
    if ((photosCount ?? 0) > 0) provenance.imageUrl = "directory";

    return withQuality({
      id: `${category}:dir_${row.id}`,
      category,
      subcategory: fieldStr(f, "primaryType"),
      name: row.name,
      headline: typeof rating === "number" ? `${rating.toFixed(1)}★` : undefined,
      rating,
      reviewCount: fieldNum(f, "userRatingsTotal"),
      phone,
      website,
      address,
      state: fieldStr(f, "state"),
      postalCode: fieldStr(f, "zip"),
      countryCode: ctx.countryCode || undefined,
      location,
      distanceMeters,
      distanceApproximate,
      externalIds: { directory_hotels: row.id },
      sources: [source],
      provenance,
      qualityScore: 0,
      quality: "insufficient",
      fetchedAt,
      expiresAt: expiresAtFor("directory", Date.parse(fetchedAt)),
      approximateLocation,
    });
  }

  // healthcare
  const npi = fieldStr(f, "npi") ?? row.id;
  const source: SourceAttribution = { kind: "registry", label: "NPPES", externalId: npi, fetchedAt };
  const credential = fieldStr(f, "credential");
  const specialty = fieldStr(f, "specialty");
  const phone = fieldStr(f, "phone");
  const provenance: Record<string, SourceKind> = { name: "registry" };
  if (fieldStr(f, "addressLine1")) provenance.address = "registry";
  if (phone) provenance.phone = "registry";
  if (location) provenance.location = "registry";
  if (credential) provenance.credentials = "registry";

  const addressParts = [fieldStr(f, "addressLine1"), fieldStr(f, "city"), fieldStr(f, "state"), fieldStr(f, "zip")]
    .filter(Boolean)
    .join(", ");

  return withQuality({
    id: `${category}:npi_${npi}`,
    category,
    subcategory: specialty,
    name: row.name,
    headline: [specialty, credential].filter(Boolean).join(" · ") || undefined,
    phone,
    address: addressParts || undefined,
    city: fieldStr(f, "city"),
    state: fieldStr(f, "state"),
    postalCode: fieldStr(f, "zip"),
    countryCode: ctx.countryCode || "US",
    location,
    distanceMeters,
    distanceApproximate,
    services: specialty ? [specialty] : undefined,
    credentials: credential ? [credential] : undefined,
    externalIds: { npi },
    sources: [source],
    provenance,
    qualityScore: 0,
    quality: "insufficient",
    fetchedAt,
    expiresAt: expiresAtFor("registry", Date.parse(fetchedAt)),
    approximateLocation,
  });
}
