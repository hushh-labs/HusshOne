/* Filtering + ranking (deliverables #5 sorting, #6 quality gating).

   `rankProfiles` takes the merged, de-duplicated profile list and produces the ordered feed:
   1. apply the caller's filters (minRating / openNow / free-text query / subcategories);
   2. sort by the requested SortOrder (recommended | nearest | rating | reviews);
   3. down-rank `insufficient` records to the very bottom — a name-only stub never sits above a real
      profile — and by default drop them entirely UNLESS nothing better exists (so an empty area still
      returns its best-effort rows rather than nothing);
   4. clamp to `limit`.

   "recommended" is a composite of quality, proximity, and reputation so the default feed leads with the
   richest, closest, best-reviewed places rather than raw distance. */

import type { DiscoveryFilters, SortOrder, UnifiedProfile } from "./types";

function matchesFilters(p: UnifiedProfile, filters: DiscoveryFilters | undefined): boolean {
  if (!filters) return true;
  if (typeof filters.minRating === "number" && !(typeof p.rating === "number" && p.rating >= filters.minRating)) {
    return false;
  }
  if (filters.openNow && p.openingHours?.openNow !== true) return false;
  if (filters.subcategories?.length) {
    const want = new Set(filters.subcategories.map((s) => s.toLowerCase()));
    const have = [p.subcategory, ...(p.services ?? [])].filter(Boolean).map((s) => s!.toLowerCase());
    if (!have.some((h) => want.has(h))) return false;
  }
  if (filters.query) {
    const q = filters.query.trim().toLowerCase();
    if (q) {
      const hay = [p.name, p.headline, p.description, p.subcategory, p.address, ...(p.services ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
  }
  return true;
}

const QUALITY_RANK = { rich: 3, standard: 2, basic: 1, insufficient: 0 } as const;

/** 0..1 proximity score within the search radius; unknown distance is treated as far (0.3). */
function proximityScore(p: UnifiedProfile, radiusMeters: number): number {
  if (typeof p.distanceMeters !== "number") return 0.3;
  const r = Math.max(1, radiusMeters);
  return Math.max(0, 1 - Math.min(p.distanceMeters, r) / r);
}

function recommendedScore(p: UnifiedProfile, radiusMeters: number): number {
  const quality = p.qualityScore / 100; // 0..1
  const proximity = proximityScore(p, radiusMeters);
  const rating = typeof p.rating === "number" ? p.rating / 5 : 0; // 0..1
  const popularity = Math.min(1, Math.log10((p.reviewCount ?? 0) + 1) / 3); // 0..1, ~1000 reviews saturates
  return quality * 0.4 + proximity * 0.3 + rating * 0.2 + popularity * 0.1;
}

/** Ascending distance; unknowns sort last. */
function byNearest(a: UnifiedProfile, b: UnifiedProfile): number {
  const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
  const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
  return da - db;
}

function comparator(sort: SortOrder, radiusMeters: number): (a: UnifiedProfile, b: UnifiedProfile) => number {
  switch (sort) {
    case "nearest":
      return byNearest;
    case "rating":
      return (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.reviewCount ?? 0) - (a.reviewCount ?? 0) || byNearest(a, b);
    case "reviews":
      return (a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0) || (b.rating ?? -1) - (a.rating ?? -1) || byNearest(a, b);
    case "recommended":
    default:
      return (a, b) => recommendedScore(b, radiusMeters) - recommendedScore(a, radiusMeters) || byNearest(a, b);
  }
}

export interface RankOptions {
  sort?: SortOrder;
  filters?: DiscoveryFilters;
  radiusMeters: number;
  limit: number;
  /** Force-include `insufficient` rows in the ranked output. Default: only when nothing better exists. */
  includeInsufficient?: boolean;
}

export function rankProfiles(profiles: UnifiedProfile[], opts: RankOptions): UnifiedProfile[] {
  const sort = opts.sort ?? "recommended";
  const cmp = comparator(sort, opts.radiusMeters);

  const filtered = profiles.filter((p) => matchesFilters(p, opts.filters));

  // Partition so insufficient always sinks below everything real, regardless of sort.
  const solid = filtered.filter((p) => p.quality !== "insufficient").sort(cmp);
  const weak = filtered.filter((p) => p.quality === "insufficient").sort((a, b) => {
    // Among weak rows, prefer the ones with a shred more signal, then proximity.
    return QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality] || b.qualityScore - a.qualityScore || byNearest(a, b);
  });

  let ordered: UnifiedProfile[];
  if (opts.includeInsufficient) ordered = [...solid, ...weak];
  else if (solid.length > 0) ordered = solid;
  else ordered = weak; // nothing better exists → return best-effort rather than an empty feed

  return ordered.slice(0, Math.max(0, opts.limit));
}
