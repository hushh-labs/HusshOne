// Postgres access layer for the graph's OWN `social` database (Cloud SQL via the
// local Auth Proxy). One shared pool. All writes are idempotent upserts keyed on
// the resolver's deterministic anchors, so a rebuild pass converges the same graph
// instead of duplicating nodes/edges.
//
// Source databases are NOT reached from here — those get their own pools (see
// source-connectors.mjs / build.mjs). This module only ever talks to `social`.

import pg from "pg";
import { config } from "./config.mjs";

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      max: config.db.max,
      // Cloud SQL Auth Proxy terminates TLS itself, so the pg connection to
      // 127.0.0.1 is plaintext loopback — no ssl config needed.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    // Don't let a transient backend error crash the 24/7 worker.
    pool.on("error", (err) => {
      console.log(JSON.stringify({ event: "pg.pool_error", db: "social", message: err.message }));
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export async function query(text, params) {
  return getPool().query(text, params);
}

// Open a pg Pool for a SOURCE database (same instance/creds as the graph DB via the
// same Cloud SQL proxy — only the database name differs). Small max: the connectors
// read sequentially. Lives here (not in source-connectors.mjs) so the pure mappers
// stay importable without the pg package installed. Caller owns end().
export function makeSourcePool(dbName) {
  return new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: dbName,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
}

// Ping used by /health and worker startup to confirm the DB is reachable.
export async function ping() {
  const { rows } = await query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// -- build runs --------------------------------------------------------------

export async function startBuildRun() {
  const { rows } = await query(
    `INSERT INTO build_runs (started_at, ok) VALUES (now(), false) RETURNING id`,
  );
  return rows[0].id;
}

export async function finishBuildRun(id, { personsUpserted, edgesUpserted, sourcesScanned, ok, error } = {}) {
  await query(
    `UPDATE build_runs
        SET finished_at = now(),
            persons_upserted = $2,
            edges_upserted = $3,
            sources_scanned = $4::jsonb,
            ok = $5,
            error = $6
      WHERE id = $1`,
    [
      id,
      personsUpserted ?? null,
      edgesUpserted ?? null,
      JSON.stringify(sourcesScanned || {}),
      !!ok,
      error ? String(error).slice(0, 2000) : null,
    ],
  );
}

// -- persons (graph nodes) ---------------------------------------------------

// Upsert resolved clusters as person rows, keyed on the deterministic cluster_key.
// Batched multi-row INSERT ... ON CONFLICT to keep round-trips down on large graphs.
// Returns Map(clusterKey -> person id) covering every input cluster.
export async function upsertPersonsBatch(clusters, { batchRows = 500 } = {}) {
  const idByCluster = new Map();
  for (const group of chunk(clusters, batchRows)) {
    const values = [];
    const tuples = group.map((c, i) => {
      const b = i * 7;
      values.push(
        c.clusterKey,
        c.canonicalName ?? null,
        c.nameKey ?? null,
        c.zip ?? null,
        c.state ?? null,
        c.profession ?? null,
        JSON.stringify(c.attributes || {}),
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::jsonb)`;
    });
    const sql = `
      INSERT INTO persons
        (cluster_key, canonical_name, name_key, primary_zip, primary_state, profession, attributes)
      VALUES ${tuples.join(", ")}
      ON CONFLICT (cluster_key) DO UPDATE SET
        canonical_name = COALESCE(EXCLUDED.canonical_name, persons.canonical_name),
        name_key       = COALESCE(EXCLUDED.name_key, persons.name_key),
        primary_zip    = COALESCE(EXCLUDED.primary_zip, persons.primary_zip),
        primary_state  = COALESCE(EXCLUDED.primary_state, persons.primary_state),
        profession     = COALESCE(EXCLUDED.profession, persons.profession),
        attributes     = EXCLUDED.attributes,
        last_seen      = now()
      RETURNING id, cluster_key`;
    const { rows } = await query(sql, values);
    for (const r of rows) idByCluster.set(r.cluster_key, r.id);
  }
  return idByCluster;
}

// Upsert provenance links. rows: [{ personId, sourceVertical, sourceKey, sourceRef }].
// UNIQUE(source_vertical, source_key) lets a rebuild re-point a source to a merged node.
export async function upsertPersonSourcesBatch(rows, { batchRows = 500 } = {}) {
  let n = 0;
  for (const group of chunk(rows, batchRows)) {
    const values = [];
    const tuples = group.map((r, i) => {
      const b = i * 4;
      values.push(r.personId, r.sourceVertical, r.sourceKey, JSON.stringify(r.sourceRef || {}));
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4}::jsonb)`;
    });
    const sql = `
      INSERT INTO person_sources (person_id, source_vertical, source_key, source_ref)
      VALUES ${tuples.join(", ")}
      ON CONFLICT (source_vertical, source_key) DO UPDATE SET
        person_id  = EXCLUDED.person_id,
        source_ref = EXCLUDED.source_ref,
        linked_at  = now()`;
    const res = await query(sql, values);
    n += res.rowCount || 0;
  }
  return n;
}

// Upsert derived edges. edges: [{ srcPersonId, dstPersonId, edgeType, weight, evidence }].
// Returns the number of rows inserted (new edges) this pass.
export async function upsertEdgesBatch(edges, { batchRows = 500 } = {}) {
  let inserted = 0;
  for (const group of chunk(edges, batchRows)) {
    const values = [];
    const tuples = group.map((e, i) => {
      const b = i * 5;
      values.push(e.srcPersonId, e.dstPersonId, e.edgeType, e.weight ?? 1.0, JSON.stringify(e.evidence || {}));
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::jsonb)`;
    });
    const sql = `
      INSERT INTO edges (src_person_id, dst_person_id, edge_type, weight, evidence)
      VALUES ${tuples.join(", ")}
      ON CONFLICT (src_person_id, dst_person_id, edge_type) DO UPDATE SET
        weight    = EXCLUDED.weight,
        evidence  = EXCLUDED.evidence,
        last_seen = now()
      RETURNING (xmax = 0) AS inserted`;
    const { rows } = await query(sql, values);
    inserted += rows.filter((r) => r.inserted).length;
  }
  return inserted;
}

// Optional GC: remove edges not re-derived since a build started (their endpoints
// or evidence disappeared upstream). OFF by default — the worker only calls this
// when explicitly enabled AND the pass actually produced persons, so an empty/
// unreachable set of source DBs can never wipe an existing graph. Never touches
// persons (nodes persist as long as any source still links them).
export async function pruneStaleEdges(buildStart) {
  const { rowCount } = await query(`DELETE FROM edges WHERE last_seen < $1`, [buildStart]);
  return rowCount;
}

// -- stats -------------------------------------------------------------------

// Single snapshot for /status and the daily roll-up.
export async function getGraphStats() {
  const [{ rows: totals }, { rows: byProf }, { rows: byType }, { rows: bySrc }, { rows: lastRun }] =
    await Promise.all([
      query(
        `SELECT (SELECT count(*) FROM persons)::int AS persons_total,
                (SELECT count(*) FROM edges)::int   AS edges_total,
                (SELECT count(*) FROM person_sources)::int AS sources_total`,
      ),
      query(`SELECT COALESCE(profession, 'unknown') AS profession, count(*)::int AS n
                FROM persons GROUP BY 1 ORDER BY n DESC`),
      query(`SELECT edge_type, count(*)::int AS n FROM edges GROUP BY 1 ORDER BY n DESC`),
      query(`SELECT source_vertical, count(*)::int AS n FROM person_sources GROUP BY 1 ORDER BY n DESC`),
      query(`SELECT id, started_at, finished_at, persons_upserted, edges_upserted,
                     sources_scanned, ok, error
                FROM build_runs ORDER BY started_at DESC LIMIT 1`),
    ]);

  const asMap = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.n]));
  return {
    personsTotal: totals[0].persons_total,
    edgesTotal: totals[0].edges_total,
    sourcesTotal: totals[0].sources_total,
    personsByProfession: asMap(byProf, "profession"),
    edgesByType: asMap(byType, "edge_type"),
    sourcesByVertical: asMap(bySrc, "source_vertical"),
    lastBuild: lastRun[0] || null,
  };
}

export async function logEmailReport({ recipients, metrics, personsTotal, edgesTotal, ok, error }) {
  await query(
    `INSERT INTO email_reports (recipients, metrics, persons_total, edges_total, ok, error)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6)`,
    [
      recipients || null,
      JSON.stringify(metrics || {}),
      personsTotal ?? null,
      edgesTotal ?? null,
      ok === undefined ? true : !!ok,
      error ? String(error).slice(0, 2000) : null,
    ],
  );
}
