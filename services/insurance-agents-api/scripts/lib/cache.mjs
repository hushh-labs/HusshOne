// One cache, persisted to disk. Unlike BrokerCheck (where the query cache held a volatile
// ranked list and only the coordinate/profile caches were worth persisting), here a query's
// result IS the data — Yext returns full agency records in the search, so there is no
// separate detail tier. Agencies change rarely, so this cache is both long-lived and worth
// surviving a restart.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Bump when the SHAPE of a cached agency changes, so a disk snapshot written by an older
 *  build is discarded rather than resurrecting the pre-change shape past a deploy. The
 *  version is part of every cache key AND the snapshot payload. */
export const SCHEMA_VERSION = 1;

class TtlCache {
  #map = new Map();

  constructor(name, ttlMs, maxEntries = 20_000) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return void this.misses++;
    if (entry.expires != null && entry.expires < Date.now()) {
      this.#map.delete(key);
      this.misses++;
      return undefined;
    }
    this.#map.delete(key);
    this.#map.set(key, entry); // LRU refresh
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.#map.size >= this.maxEntries) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, { value, expires: this.ttlMs == null ? null : Date.now() + this.ttlMs });
    return value;
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

  export() {
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of this.#map) {
      if (entry.expires != null && entry.expires < now) continue;
      entries.push([key, entry.value, entry.expires]);
    }
    return { name: this.name, entries };
  }

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

/** Query -> ranked agency list, keyed by geohash cell + radius. Agencies are slow-moving,
 *  so a day's TTL is fine and keeps Yext load minimal. */
export const queryCache = new TtlCache("query", 24 * HOUR, 10_000);

export const allCacheStats = () => [queryCache.stats];

// --- disk fallback ----------------------------------------------------------
import fs from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_PATH = process.env.CACHE_SNAPSHOT_PATH || "/var/lib/insurance-agents/cache-snapshot.json";
const PERSISTED = [queryCache];

let lastSaveAt = null;
let lastLoad = null;

/** Atomic write (temp + rename), so a crash mid-write can't leave an unparseable file. */
export async function saveSnapshot(file = SNAPSHOT_PATH) {
  const payload = {
    version: 1,
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    caches: PERSISTED.map((c) => c.export()),
  };
  const temp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(payload), "utf8");
  await fs.rename(temp, file);
  lastSaveAt = payload.savedAt;
  return { file, entries: payload.caches.reduce((n, c) => n + c.entries.length, 0), savedAt: payload.savedAt };
}

/** Load a snapshot if present, current-version, and parseable. Anything else → start cold. */
export async function loadSnapshot(file = SNAPSHOT_PATH) {
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8"));
    if (payload?.version !== 1) throw new Error(`unsupported snapshot version ${payload?.version}`);
    if (payload?.schemaVersion !== SCHEMA_VERSION) {
      lastLoad = { restored: 0, error: `snapshot schemaVersion ${payload?.schemaVersion} != ${SCHEMA_VERSION}; discarded` };
      return lastLoad;
    }
    const byName = new Map(PERSISTED.map((c) => [c.name, c]));
    let restored = 0;
    for (const snap of payload.caches || []) restored += byName.get(snap.name)?.import(snap) ?? 0;
    lastLoad = { restored, savedAt: payload.savedAt };
    return lastLoad;
  } catch (error) {
    lastLoad = { restored: 0, error: error.code === "ENOENT" ? "no snapshot yet" : error.message };
    return lastLoad;
  }
}

export function startSnapshotTimer(intervalMs = Number(process.env.CACHE_SNAPSHOT_INTERVAL_MS) || 300_000) {
  const timer = setInterval(() => {
    saveSnapshot().catch((error) => console.warn(JSON.stringify({ event: "cache.snapshot_failed", error: error.message })));
  }, intervalMs);
  timer.unref();
  return timer;
}

export const persistenceStatus = () => ({ file: SNAPSHOT_PATH, lastSaveAt, lastLoad });
