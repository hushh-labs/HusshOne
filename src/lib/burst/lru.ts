/* A tiny bounded LRU map — keeps memory flat under unbounded key cardinality.
   Used for the per-tenant GCP auth-client cache (BYOC means many distinct service
   accounts) and the mock provider's in-flight job table, so neither can grow without
   bound on a long-lived process. O(1) get/set/delete (Map insertion-order eviction). */
export class BoundedLru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new Error("BoundedLru maxSize must be >= 1");
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Touch: re-insert so this key becomes most-recently-used.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    // Re-inserting an existing key must also refresh its recency.
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    // Evict the least-recently-used entries until we're within capacity.
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
