/* Dedup + merge (deliverable #5): fold profiles that describe the SAME real-world entity — whether they
   came from the seeded directory, an authoritative registry, or a live provider — into one record.

   Matching (any strong key links two profiles):
   • a shared external id (place_id / NPI / directory id)
   • the same phone (last-10 digits)
   • the same website domain + a similar name
   • a similar normalized name AND coordinates within ~150 m

   Merge uses per-field SOURCE PREFERENCE so the most authoritative value wins, and records which source
   supplied each winning field in `provenance`:
   • registry → credentials / licensing
   • Google Places → location / ratings / reviews / hours / photos
   • the most-verified contact for phone/website; the formatted maps address for address
   The stable INTERNAL id prefers our own registry/directory id over the volatile place_id. Quality is
   re-scored after the merge (a merged record is usually richer than either input alone). */

import type { SourceAttribution, SourceKind, UnifiedProfile } from "./types";
import { withQuality } from "./quality";
import { haversineMeters } from "./location";

// --- key normalization ---------------------------------------------------

export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function phoneDigits(phone: string | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

function websiteDomain(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Strong keys that, if shared, mean two profiles are the same entity. */
function strongKeys(p: UnifiedProfile): string[] {
  const keys: string[] = [];
  for (const [ns, id] of Object.entries(p.externalIds)) {
    if (ns === "dedup") continue;
    if (id) keys.push(`${ns}:${id}`);
  }
  const ph = phoneDigits(p.phone);
  if (ph) keys.push(`ph:${ph}`);
  const dom = websiteDomain(p.website);
  const nn = normalizeName(p.name);
  if (dom && nn) keys.push(`web:${dom}|${nn.slice(0, 24)}`);
  return keys;
}

// --- union-find ----------------------------------------------------------

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** ~150 m + similar name — the soft key for entities that lack a shared id/phone/domain. */
function fuzzySameEntity(a: UnifiedProfile, b: UnifiedProfile): boolean {
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  if (!na || !nb) return false;
  const nameMatch = na === nb || na.startsWith(nb) || nb.startsWith(na);
  if (!nameMatch) return false;
  if (!a.location || !b.location) return true; // same name, no coords to contradict → treat as same
  return haversineMeters(a.location.lat, a.location.lng, b.location.lat, b.location.lng) <= 150;
}

// --- field preference ----------------------------------------------------

const DEFAULT_PREF: SourceKind[] = ["google_places", "registry", "directory", "osm", "grounded_web", "user_input"];
const FIELD_PREF: Record<string, SourceKind[]> = {
  id: ["registry", "directory", "osm", "google_places", "grounded_web", "user_input"],
  credentials: ["registry", "directory", "grounded_web", "google_places", "osm", "user_input"],
  services: ["registry", "google_places", "grounded_web", "directory", "osm", "user_input"],
  description: ["grounded_web", "google_places", "directory", "registry", "osm", "user_input"],
  location: ["google_places", "directory", "registry", "osm", "user_input", "grounded_web"],
  rating: ["google_places", "directory", "osm", "registry", "grounded_web", "user_input"],
  reviewCount: ["google_places", "directory", "osm", "registry", "grounded_web", "user_input"],
  reviews: ["google_places", "grounded_web", "directory", "registry", "osm", "user_input"],
  openingHours: ["google_places", "directory", "osm", "registry", "grounded_web", "user_input"],
  imageUrl: ["google_places", "directory", "osm", "grounded_web", "registry", "user_input"],
  address: ["google_places", "registry", "directory", "osm", "grounded_web", "user_input"],
  phone: ["registry", "google_places", "directory", "osm", "grounded_web", "user_input"],
  website: ["registry", "google_places", "directory", "osm", "grounded_web", "user_input"],
};

function kindOfField(p: UnifiedProfile, field: string): SourceKind {
  return p.provenance[field] ?? p.sources[0]?.kind ?? "directory";
}
function rankOf(kind: SourceKind, field: string): number {
  const list = FIELD_PREF[field] ?? DEFAULT_PREF;
  const i = list.indexOf(kind);
  return i < 0 ? 999 : i;
}

interface Winner<T> {
  value: T;
  kind: SourceKind;
}

function best<T>(group: UnifiedProfile[], field: string, get: (p: UnifiedProfile) => T | undefined | null): Winner<T> | undefined {
  let winner: (Winner<T> & { rank: number }) | undefined;
  for (const p of group) {
    const v = get(p);
    if (v === undefined || v === null || v === "") continue;
    const kind = kindOfField(p, field);
    const rank = rankOf(kind, field);
    if (!winner || rank < winner.rank) winner = { value: v as T, kind, rank };
  }
  return winner ? { value: winner.value, kind: winner.kind } : undefined;
}

function unionArray(group: UnifiedProfile[], get: (p: UnifiedProfile) => string[] | undefined): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of group) {
    for (const item of get(p) ?? []) {
      const k = item.trim();
      if (k && !seen.has(k.toLowerCase())) {
        seen.add(k.toLowerCase());
        out.push(k);
      }
    }
  }
  return out.length ? out : undefined;
}

function mergeSources(group: UnifiedProfile[]): SourceAttribution[] {
  const seen = new Set<string>();
  const out: SourceAttribution[] = [];
  for (const p of group) {
    for (const s of p.sources) {
      const k = `${s.kind}:${s.externalId ?? s.label}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(s);
      }
    }
  }
  return out;
}

function mergeGroup(group: UnifiedProfile[]): UnifiedProfile {
  if (group.length === 1) return group[0];

  // Stable internal id: pick the profile whose source kind ranks best for "id".
  const idWinner = [...group].sort((a, b) => rankOf(a.sources[0]?.kind ?? "directory", "id") - rankOf(b.sources[0]?.kind ?? "directory", "id"))[0];

  const externalIds: Record<string, string> = {};
  for (const p of group) Object.assign(externalIds, p.externalIds);

  const provenance: Record<string, SourceKind> = {};
  const setField = <T>(field: string, get: (p: UnifiedProfile) => T | undefined | null): T | undefined => {
    const w = best(group, field, get);
    if (w) provenance[field] = w.kind;
    return w?.value;
  };

  const name = setField("name", (p) => p.name) ?? idWinner.name;
  const location = setField("location", (p) => p.location);
  const rating = setField("rating", (p) => p.rating);
  const imageUrl = setField("imageUrl", (p) => p.imageUrl);
  // Photo availability signal survives merge even when no URL is resolved yet.
  if (!provenance.imageUrl) {
    const photoSig = group.find((p) => p.provenance.imageUrl);
    if (photoSig) provenance.imageUrl = photoSig.provenance.imageUrl;
  }

  const credentials = unionArray(group, (p) => p.credentials);
  if (credentials) provenance.credentials = best(group, "credentials", (p) => (p.credentials?.length ? p.credentials : undefined))?.kind ?? "registry";
  const services = unionArray(group, (p) => p.services);
  if (services) provenance.services = best(group, "services", (p) => (p.services?.length ? p.services : undefined))?.kind ?? "directory";

  const approximateLocation = location ? location.precision !== "rooftop" : group.every((p) => p.approximateLocation);
  const distanceApproximate = group.some((p) => p.distanceApproximate) || approximateLocation;
  const distanceMeters = best(group, "location", (p) => (p.location ? p.distanceMeters : undefined))?.value ?? group.map((p) => p.distanceMeters).find((d) => d != null);

  const fetchedAt = group.map((p) => p.fetchedAt).sort().at(-1)!;
  const expiries = group.map((p) => p.expiresAt).filter((e): e is string => !!e).sort();
  const expiresAt = expiries[0]; // soonest expiry → refresh when the fastest-decaying source goes stale

  return withQuality({
    id: idWinner.id,
    category: idWinner.category,
    subcategory: setField("subcategory", (p) => p.subcategory),
    name,
    headline: setField("headline", (p) => p.headline),
    description: setField("description", (p) => p.description),
    imageUrl,
    rating,
    reviewCount: setField("reviewCount", (p) => p.reviewCount),
    reviews: setField("reviews", (p) => p.reviews),
    phone: setField("phone", (p) => p.phone),
    website: setField("website", (p) => p.website),
    address: setField("address", (p) => p.address),
    city: setField("city", (p) => p.city),
    state: setField("state", (p) => p.state),
    postalCode: setField("postalCode", (p) => p.postalCode),
    countryCode: setField("countryCode", (p) => p.countryCode),
    location,
    distanceMeters,
    distanceApproximate,
    openingHours: setField("openingHours", (p) => p.openingHours),
    services,
    credentials,
    externalIds,
    sources: mergeSources(group),
    provenance,
    qualityScore: 0,
    quality: "insufficient",
    fetchedAt,
    expiresAt,
    approximateLocation,
  });
}

/** Deduplicate + merge a flat list of profiles (already all one category, but safe across categories:
 *  strong keys are namespaced and fuzzy matching only fires within equal normalized names). */
export function dedupeAndMerge(profiles: UnifiedProfile[]): UnifiedProfile[] {
  if (profiles.length <= 1) return profiles;

  const uf = new UnionFind(profiles.length);

  // Link by strong keys.
  const keyToIndex = new Map<string, number>();
  profiles.forEach((p, i) => {
    for (const k of strongKeys(p)) {
      const prev = keyToIndex.get(k);
      if (prev === undefined) keyToIndex.set(k, i);
      else uf.union(prev, i);
    }
  });

  // Link by fuzzy name+geo (bounded O(n²); n is a single page of results, ~40).
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      if (uf.find(i) === uf.find(j)) continue;
      if (fuzzySameEntity(profiles[i], profiles[j])) uf.union(i, j);
    }
  }

  const groups = new Map<number, UnifiedProfile[]>();
  profiles.forEach((p, i) => {
    const root = uf.find(i);
    const g = groups.get(root);
    if (g) g.push(p);
    else groups.set(root, [p]);
  });

  return [...groups.values()].map(mergeGroup);
}
