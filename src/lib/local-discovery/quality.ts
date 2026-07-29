/* Profile quality scoring (deliverable #6).

   A measurable 0..100 score over field completeness, corroboration, and reputation, bucketed into
   rich / standard / basic / insufficient. The hard rule the brief calls out: a record that is essentially
   just a name (+ postal code) must classify `insufficient` so the feed never presents it as a complete
   profile. Insufficient rows are hidden/heavily down-ranked by the ranker unless nothing better exists.

   Photo availability is a valid richness signal even though the media URL is resolved at VIEW time (Google
   ToS): normalizers mark `provenance.imageUrl` when a provider has a photo, and we read that here. */

import type { ProfileQuality, UnifiedProfile } from "./types";

export const QUALITY_THRESHOLDS = { rich: 75, standard: 50, basic: 25 } as const;

export function classifyQuality(score: number): ProfileQuality {
  if (score >= QUALITY_THRESHOLDS.rich) return "rich";
  if (score >= QUALITY_THRESHOLDS.standard) return "standard";
  if (score >= QUALITY_THRESHOLDS.basic) return "basic";
  return "insufficient";
}

/** Score a profile purely from its assembled fields, so it is re-runnable after a merge. */
export function scoreProfile(p: UnifiedProfile): { score: number; quality: ProfileQuality } {
  let score = 0;

  // Identity & location (max 30) — a mappable point + a real street address is worth more than a centroid.
  if (p.name) score += 8;
  if (p.address) score += 8;
  if (p.location && !p.approximateLocation) score += 8;
  else if (p.location) score += 3; // centroid-only location is weaker
  if (p.city || p.postalCode) score += 3;
  if (p.countryCode) score += 3;

  // Contact (max 20).
  if (p.phone) score += 10;
  if (p.website) score += 10;

  // Reputation (max 20).
  if (typeof p.rating === "number") score += 8;
  if ((p.reviewCount ?? 0) > 0) score += 6;
  if (p.reviews?.length) score += 6;

  // Richness (max 20). imageUrl is view-time; `provenance.imageUrl` means a provider CAN supply one.
  const hasImage = !!p.imageUrl || p.provenance?.imageUrl != null;
  if (p.description || p.headline) score += 6;
  if (hasImage) score += 6;
  if (p.openingHours?.weekdayText?.length) score += 4;
  if (p.services?.length) score += 4;

  // Credibility (max 10) — credentials/licensing + corroboration by more than one source.
  if (p.credentials?.length) score += 5;
  if (p.sources.length >= 2) score += 5;

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Hard floor: essentially name-only (optionally + postal) can never out-rank a real profile.
  const hasSubstance =
    !!p.address || !!p.phone || !!p.website || typeof p.rating === "number" || !!p.description || hasImage;
  if (!hasSubstance) return { score: Math.min(score, 20), quality: "insufficient" };

  return { score, quality: classifyQuality(score) };
}

/** Apply the score to a profile in place-returning fashion. */
export function withQuality(p: UnifiedProfile): UnifiedProfile {
  const { score, quality } = scoreProfile(p);
  return { ...p, qualityScore: score, quality };
}
