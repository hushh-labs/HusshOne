/* Local Discovery caching (deliverable #7).

   Two layers, both in-process for Phase 1 (a shared Redis/Memorystore store is deferred to Phase 3 — see
   the search orchestrator note):
   • SEARCH cache — key = country + rounded coordinates + radius bucket + category + filters. Holds the
     normalized profile list for a search so a repeat/paginated request skips the paid provider fan-out.
   • ENTITY cache — key = the profile's namespaced internal id. Holds the last normalized profile so detail
     views and dedup reuse it.

   Both are BOUNDED (LRU + per-entry TTL) — memory is capped just like spend is, honoring "no uncapped
   background job / backfill". State lives on `globalThis` so it survives dev module reloads but stays
   per-instance in prod (mirrors spend.ts / reliability.ts).

   ToS: we only ever cache the permitted fields already baked into `UnifiedProfile` (stable ids + attribution
   + a rating/address snapshot). Freshness-sensitive, non-cacheable Google content — photo media URLs and
   full review bodies — is resolved at VIEW time (see providers/places.ts `resolvePlacePhoto`) and is never
   stored here. TTLs stay short so snapshots don't drift. */

import type { DiscoveryCategory, DiscoveryFilters, UnifiedProfile } from "./types";

export interface CacheConfig {
  searchTtlMs: number;
  entityTtlMs: number;
  maxSearchEntries: number;
  maxEntityEntries: number;
  /** Decimal places used to round coordinates into the search key (~111 m at 3 dp). */
  coordDecimals: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getCacheConfig(): CacheConfig {
  return {
    searchTtlMs: intEnv("LOCAL_DISCOVERY_SEARCH_TTL_SEC", 600) * 1000, // 10 min
    entityTtlMs: intEnv("LOCAL_DISCOVERY_ENTITY_TTL_SEC", 21_600) * 1000, // 6 h
    maxSearchEntries: intEnv("LOCAL_DISCOVERY_SEARCH_CACHE_MAX", 500),
    maxEntityEntries: intEnv("LOCAL_DISCOVERY_ENTITY_CACHE_MAX", 5000),
    coordDecimals: intEnv("LOCAL_DISCOVERY_CACHE_COORD_DECIMALS", 3),
  };
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

/** Small insertion/access-ordered LRU with per-entry TTL. Map preserves insertion order; re-inserting on
 *  read moves an entry to the most-recently-used end, so eviction drops the least-recently-used key. */
class TtlLru<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(private max: number) {}

  get(key: string): T | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      this.map.delete(key);
      return null;
    }
    // Bump recency.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.map.has(key)) this.map.delete(key);
    const now = Date.now();
    this.map.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

interface CacheState {
  search: TtlLru<UnifiedProfile[]>;
  entity: TtlLru<UnifiedProfile>;
}

const GLOBAL_KEY = "__oneLocalDiscoveryCache__";

function state(): CacheState {
  const g = globalThis as unknown as Record<string, CacheState | undefined>;
  if (!g[GLOBAL_KEY]) {
    const cfg = getCacheConfig();
    g[GLOBAL_KEY] = {
      search: new TtlLru<UnifiedProfile[]>(cfg.maxSearchEntries),
      entity: new TtlLru<UnifiedProfile>(cfg.maxEntityEntries),
    };
  }
  return g[GLOBAL_KEY]!;
}

function roundTo(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

/** Stable, order-independent serialization of the filters that affect result identity. */
function filtersKey(filters: DiscoveryFilters | undefined): string {
  if (!filters) return "-";
  const parts: string[] = [];
  if (typeof filters.minRating === "number") parts.push(`r${filters.minRating}`);
  if (filters.openNow) parts.push("open");
  if (filters.query) parts.push(`q:${filters.query.trim().toLowerCase()}`);
  if (filters.subcategories?.length) parts.push(`s:${[...filters.subcategories].map((s) => s.toLowerCase()).sort().join("+")}`);
  return parts.length ? parts.join("|") : "-";
}

export interface SearchKeyInput {
  countryCode: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  category: DiscoveryCategory;
  filters?: DiscoveryFilters;
}

export function searchCacheKey(input: SearchKeyInput): string {
  const { coordDecimals } = getCacheConfig();
  const cc = (input.countryCode || "??").toUpperCase();
  const lat = roundTo(input.lat, coordDecimals);
  const lng = roundTo(input.lng, coordDecimals);
  // Bucket the radius so near-identical radii share a cache slot.
  const radiusBucket = Math.round(input.radiusMeters / 500) * 500;
  return `${cc}:${lat},${lng}:${radiusBucket}:${input.category}:${filtersKey(input.filters)}`;
}

export function getCachedSearch(key: string): UnifiedProfile[] | null {
  return state().search.get(key);
}

export function setCachedSearch(key: string, profiles: UnifiedProfile[]): void {
  const { searchTtlMs } = getCacheConfig();
  state().search.set(key, profiles, searchTtlMs);
  // Warm the entity cache too so detail lookups are free right after a search.
  setCachedEntities(profiles);
}

export function getCachedEntity(id: string): UnifiedProfile | null {
  return state().entity.get(id);
}

export function setCachedEntity(profile: UnifiedProfile): void {
  const { entityTtlMs } = getCacheConfig();
  state().entity.set(profile.id, profile, entityTtlMs);
}

export function setCachedEntities(profiles: UnifiedProfile[]): void {
  const { entityTtlMs } = getCacheConfig();
  const s = state().entity;
  for (const p of profiles) s.set(p.id, p, entityTtlMs);
}

export interface CacheSnapshot {
  searchEntries: number;
  entityEntries: number;
  config: CacheConfig;
}

export function cacheSnapshot(): CacheSnapshot {
  const s = state();
  return { searchEntries: s.search.size, entityEntries: s.entity.size, config: getCacheConfig() };
}

export function __resetCacheForTests(): void {
  const g = globalThis as unknown as Record<string, CacheState | undefined>;
  g[GLOBAL_KEY] = undefined;
}
