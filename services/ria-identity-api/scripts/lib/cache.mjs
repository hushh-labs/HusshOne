// Three caches with three different lifetimes. Collapsing them into one TTL throws away
// the biggest win: branch coordinates are effectively permanent (office buildings do not
// move) while a query's result list is volatile.
//
// In-process for now — deliberately. A single VM serves this endpoint, so a Map is the
// correct amount of machinery until there is a second one. The interface is async and
// key-based so swapping in Postgres later touches only this file.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Bump whenever the SHAPE of a cached record changes.
 *
 *  This exists because of a real incident: adding SEC IAPD enrichment changed the profile
 *  shape, but the disk snapshot faithfully restored pre-change profiles and kept serving them
 *  for the rest of their 7-day TTL — so the fix appeared not to have deployed. Persistence
 *  turned a harmless in-memory cache into a way to outlive a code change.
 *
 *  The version is part of every cache key AND of the snapshot payload, so a bump invalidates
 *  both at once. Cost of bumping: one cold rebuild. Cost of forgetting: silently serving the
 *  old shape.
 *
 *  v2 — added dataSources + SEC IAPD enrichment for adviser-only individuals */
export const SCHEMA_VERSION = 2;

class TtlCache {
  #map = new Map();

  constructor(name, ttlMs, maxEntries = 50_000) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.hits = 0;
    this.misses = 0;
    /** True once this instance is on the PERSISTED list below — i.e. everything in it is
     *  written to disk by saveSnapshot(). Set there, not here, so the two can never disagree.
     *
     *  It exists so a CALLER can ask "does this cache reach the disk?" before putting
     *  third-party data in it. iapd.mjs reads it: a firm-SEARCH key contains the search
     *  string, which on the Places chain is a Google business name that the Maps Platform
     *  terms forbid us from persisting. */
    this.persisted = false;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expires != null && entry.expires < Date.now()) {
      this.#map.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh LRU position so hot keys survive eviction.
    this.#map.delete(key);
    this.#map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.#map.size >= this.maxEntries) {
      // Map preserves insertion order, so the first key is the least-recently-used.
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, { value, expires: this.ttlMs == null ? null : Date.now() + this.ttlMs });
    return value;
  }

  /** Read-through: returns the cached value or computes, stores and returns a fresh one.
   *  A rejected producer is never cached. */
  async wrap(key, produce) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    return this.set(key, await produce());
  }

  get stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      size: this.#map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Math.round((this.hits / total) * 100) / 100 : null,
    };
  }

  /** Serialisable snapshot. Expiry is stored as an ABSOLUTE timestamp, so a restart cannot
   *  silently extend an entry's life the way a stored "remaining TTL" would. Already-expired
   *  entries are dropped here rather than written out. */
  export() {
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of this.#map) {
      if (entry.expires != null && entry.expires < now) continue;
      entries.push([key, entry.value, entry.expires]);
    }
    return { name: this.name, entries };
  }

  /** Restore a snapshot, skipping anything that expired while the process was down. */
  import(snapshot) {
    if (!snapshot?.entries?.length) return 0;
    const now = Date.now();
    let restored = 0;
    for (const [key, value, expires] of snapshot.entries) {
      if (expires != null && expires < now) continue;
      if (this.#map.size >= this.maxEntries) break;
      this.#map.set(key, { value, expires });
      restored++;
    }
    return restored;
  }
}

/** Branch coordinates, keyed by ZIP or branchOfficeId. Buildings do not move, so this
 *  never expires — and because thousands of reps share one office, it is the single
 *  highest-leverage cache in the service. */
export const branchGeoCache = new TtlCache("branchGeo", null, 200_000);

/** Full profiles, keyed by CRD. FINRA's own freshness SLA is ~2 business days from
 *  filing, so a shorter TTL would buy nothing but load. */
export const profileCache = new TtlCache("profile", 7 * DAY, 100_000);

/** Firm records, keyed by firm CRD. Longer-lived than individuals — a firm's address and
 *  phone change far less often than a person's registrations. Also far higher leverage:
 *  thousands of advisers share a handful of employers, so this is near-100% hit rate
 *  after the first few queries in an area. */
export const firmCache = new TtlCache("firm", 30 * DAY, 20_000);

/** Query -> ordered candidate list, keyed by geohash cell + radius + filter. The
 *  volatile one. This is also what makes PAGINATION free: page 2 of a result set is a
 *  slice of an already-ranked, already-cached list, not a second trip to FINRA. */
export const queryCache = new TtlCache("query", 6 * HOUR, 5_000);

export const allCacheStats = () => [branchGeoCache.stats, profileCache.stats, firmCache.stats, queryCache.stats];

// ---------------------------------------------------------------------------
// Disk fallback
//
// The caches live in RAM, which is fast but evaporates on restart — a deploy or a reboot
// would otherwise send every user back to a 2-4s cold path at once, right at the moment the
// service is least able to absorb it. So we snapshot to a single JSON file and reload on
// boot. Deliberately NOT a database: this is a rebuildable convenience, and losing the file
// costs latency, never correctness.
//
// The query cache is excluded on purpose — it holds a ranked list of people, which is the
// most volatile thing here and the cheapest to rebuild. Coordinates, profiles and firms are
// what actually cost upstream calls, and they change on a timescale of weeks.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_PATH = process.env.CACHE_SNAPSHOT_PATH || "/var/lib/ria-identity/cache-snapshot.json";
const PERSISTED = [branchGeoCache, profileCache, firmCache];
/** THE list, and the flag, are the same fact. Marking the instances here means a caller can
 *  ask any cache whether it reaches the disk without importing this module's internals — and
 *  adding a cache to PERSISTED can never forget to say so. */
for (const cache of PERSISTED) cache.persisted = true;

let lastSaveAt = null;
let lastLoad = null;

/** Write a snapshot atomically: temp file then rename, so a crash mid-write cannot leave a
 *  half-written file that fails to parse on the next boot. */
export async function saveSnapshot(file = SNAPSHOT_PATH) {
  const payload = {
    version: 1,
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    caches: PERSISTED.map((cache) => cache.export()),
  };
  const temp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(payload), "utf8");
  await fs.rename(temp, file);
  lastSaveAt = payload.savedAt;
  const entries = payload.caches.reduce((n, c) => n + c.entries.length, 0);
  return { file, entries, savedAt: payload.savedAt };
}

/** Load a snapshot if one exists. A missing or corrupt file is NOT an error — the service
 *  simply starts cold, which is exactly the behaviour it had before persistence existed. */
export async function loadSnapshot(file = SNAPSHOT_PATH) {
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8"));
    if (payload?.version !== 1) throw new Error(`unsupported snapshot version ${payload?.version}`);
    // A snapshot written by an older record shape must be discarded, not restored — otherwise
    // it resurrects the pre-change shape and masks the deploy that fixed it.
    if (payload?.schemaVersion !== SCHEMA_VERSION) {
      lastLoad = { restored: 0, error: `snapshot schemaVersion ${payload?.schemaVersion} != ${SCHEMA_VERSION}; discarded` };
      return lastLoad;
    }
    const byName = new Map(PERSISTED.map((cache) => [cache.name, cache]));
    let restored = 0;
    for (const snapshot of payload.caches || []) {
      restored += byName.get(snapshot.name)?.import(snapshot) ?? 0;
    }
    lastLoad = { restored, savedAt: payload.savedAt, ageMinutes: Math.round((Date.now() - Date.parse(payload.savedAt)) / 60_000) };
    return lastLoad;
  } catch (error) {
    lastLoad = { restored: 0, error: error.code === "ENOENT" ? "no snapshot yet" : error.message };
    return lastLoad;
  }
}

/** Save periodically so an abrupt kill (OOM, `kill -9`, host failure) still loses only the
 *  last few minutes rather than everything. Complements the clean-shutdown save. */
export function startSnapshotTimer(intervalMs = Number(process.env.CACHE_SNAPSHOT_INTERVAL_MS) || 300_000) {
  const timer = setInterval(() => {
    saveSnapshot().catch((error) =>
      console.warn(JSON.stringify({ event: "cache.snapshot_failed", error: error.message })),
    );
  }, intervalMs);
  timer.unref(); // never hold the process open just to snapshot
  return timer;
}

export const persistenceStatus = () => ({ file: SNAPSHOT_PATH, lastSaveAt, lastLoad });
