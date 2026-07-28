/* Read-only connection layer for the directory proximity API (GET /api/v1/directory).
   The five directory datasets live in ONE Cloud SQL instance
   (hushh-tech-prod:us-central1:hushh-directories-db, Postgres 16 + PostGIS 3.6) as separate DATABASES,
   one per vertical. There is no single SQL that spans databases, so we keep one lazy `pg.Pool` per
   database (same socket host / user / password, different `database`) and fan out one query per vertical.

   Connection mirrors how the `one` app already reaches its own Cloud SQL DB: a unix socket path in
   DIRECTORIES_DB_HOST (e.g. /cloudsql/hushh-tech-prod:us-central1:hushh-directories-db) — or a TCP host
   for the local Cloud SQL Auth Proxy. The runtime user is a SELECT-only role; parameterized queries plus
   RO privileges are defense-in-depth for a public endpoint.

   `hasDirectoryDb()` mirrors hasDatabaseUrl() in ../db/prisma.ts: when creds are unset the route degrades
   gracefully (503 directory_unavailable) instead of throwing. */
import { Pool } from "pg";

/** The four coordinate verticals exposed by the proximity API. `social` is intentionally excluded
 *  (relationship graph, no coordinates). */
export type DirectoryVertical = "hotels" | "healthcare" | "ria" | "insurance";

export const DIRECTORY_VERTICALS: readonly DirectoryVertical[] = ["hotels", "healthcare", "ria", "insurance"] as const;

/** vertical → physical database name on hushh-directories-db (confirmed from each service's PGDATABASE). */
const DB_NAME: Record<DirectoryVertical, string> = {
  hotels: "hotel_scraper",
  healthcare: "healthcare",
  ria: "ria",
  insurance: "insurance",
};

// Pools are cached on globalThis so Next.js dev hot-reload doesn't leak a new pool per reload
// (same pattern as the Prisma client singleton).
const globalForDir = globalThis as unknown as { __directoryPools?: Map<string, Pool> };
const pools: Map<string, Pool> = (globalForDir.__directoryPools ??= new Map());

/** True when the directory DB credentials are configured. Route returns 503 when false. */
export function hasDirectoryDb(): boolean {
  return Boolean(
    process.env.DIRECTORIES_DB_HOST?.trim() &&
      process.env.DIRECTORIES_DB_USER?.trim() &&
      process.env.DIRECTORIES_DB_PASSWORD?.trim(),
  );
}

function makePool(database: string): Pool {
  const host = process.env.DIRECTORIES_DB_HOST!.trim();
  return new Pool({
    host, // unix socket dir (/cloudsql/...) in prod, or 127.0.0.1 via the local auth proxy
    port: Number(process.env.DIRECTORIES_DB_PORT) || 5432,
    database,
    user: process.env.DIRECTORIES_DB_USER!.trim(),
    password: process.env.DIRECTORIES_DB_PASSWORD!.trim(),
    // A public read endpoint must never hang: cap connect + per-statement time and keep the pool small.
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 8_000,
    query_timeout: 8_000,
    application_name: "one-directory-api",
  });
}

/** Lazily create (and cache) the Pool for a vertical's database. Returns null when creds are unset. */
export function getDirectoryPool(vertical: DirectoryVertical): Pool | null {
  if (!hasDirectoryDb()) return null;
  const database = DB_NAME[vertical];
  let pool = pools.get(database);
  if (!pool) {
    pool = makePool(database);
    // A pool-level error (e.g. a dropped idle socket) must not crash the process; log and let the next
    // query re-establish. Individual query failures are handled per-vertical in the route.
    pool.on("error", (err) => {
      console.warn(JSON.stringify({ event: "one.v1.directory.pool_error", database, message: err.message }));
    });
    pools.set(database, pool);
  }
  return pool;
}
