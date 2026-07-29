// Postgres access layer (Cloud SQL + PostGIS via the local Auth Proxy).
// One shared pool. All licensee writes go through upsertProducer() so repeated
// license rows merge onto a single row by (source_state, license_no); the per-state
// work queue is drained by claimNextState().

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
      console.log(JSON.stringify({ event: "pg.pool_error", message: err.message }));
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

// Ping used by /health and the init step to confirm the DB is reachable.
export async function ping() {
  const { rows } = await query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}

// -- ZIP geo-reference --------------------------------------------------------

// Bulk-load ZIPs (from GeoNames) idempotently. Existing rows keep whatever else
// references them; only the static geo fields are refreshed. Returns inserted count.
// Signature/columns are identical to the fleet loader so scripts/load-zips.mjs is shared.
export async function insertZipsBatch(rows) {
  if (!rows.length) return 0;
  const cols = ["zip", "city", "state", "county", "lat", "lng", "dist_km_from_kirkland"];
  const values = [];
  const tuples = rows.map((r, i) => {
    const base = i * cols.length;
    values.push(r.zip, r.city, r.state, r.county, r.lat, r.lng, r.distKm);
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
  });
  const sql = `
    INSERT INTO zips (${cols.join(", ")})
    VALUES ${tuples.join(", ")}
    ON CONFLICT (zip) DO UPDATE SET
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      county = EXCLUDED.county,
      lat = EXCLUDED.lat,
      lng = EXCLUDED.lng,
      dist_km_from_kirkland = EXCLUDED.dist_km_from_kirkland,
      updated_at = now()
    RETURNING (xmax = 0) AS inserted`;
  const { rows: out } = await query(sql, values);
  return out.filter((o) => o.inserted).length;
}

// -- Producers ---------------------------------------------------------------

// Insert or merge one normalized producer record. Conflict on (source_state,
// license_no) merges repeated license rows for the same licensee: COALESCE keeps an
// existing value when the incoming row lacks a field, license_types / lines_of_authority
// / sources are unioned, and lat/lng are geo-tagged from the `zips` centroid of the
// licensee's mailing ZIP. first_seen is never moved. Returns { id, inserted } or null.
export async function upsertProducer(rec) {
  if (!rec || !rec.sourceState || !rec.licenseNo) return null;
  const sql = `
    INSERT INTO producers (
      source_state, license_no, npn, full_name, first_name, last_name,
      entity_type, license_types, lines_of_authority, status,
      address_line1, address_line2, city, state, zip,
      lat, lng, phone, sources, raw
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8::text[], $9::text[], $10,
      $11, $12, $13, $14, $15,
      (SELECT lat FROM zips WHERE zip = $15),
      (SELECT lng FROM zips WHERE zip = $15),
      $16, $17::text[], $18
    )
    ON CONFLICT (source_state, license_no) DO UPDATE SET
      npn                = COALESCE(EXCLUDED.npn, producers.npn),
      full_name          = COALESCE(EXCLUDED.full_name, producers.full_name),
      first_name         = COALESCE(EXCLUDED.first_name, producers.first_name),
      last_name          = COALESCE(EXCLUDED.last_name, producers.last_name),
      entity_type        = COALESCE(EXCLUDED.entity_type, producers.entity_type),
      license_types      = (SELECT ARRAY(SELECT DISTINCT unnest(producers.license_types || EXCLUDED.license_types))),
      lines_of_authority = (SELECT ARRAY(SELECT DISTINCT unnest(producers.lines_of_authority || EXCLUDED.lines_of_authority))),
      status             = COALESCE(EXCLUDED.status, producers.status),
      address_line1      = COALESCE(EXCLUDED.address_line1, producers.address_line1),
      address_line2      = COALESCE(EXCLUDED.address_line2, producers.address_line2),
      city               = COALESCE(EXCLUDED.city, producers.city),
      state              = COALESCE(EXCLUDED.state, producers.state),
      zip                = COALESCE(EXCLUDED.zip, producers.zip),
      lat                = COALESCE(EXCLUDED.lat, producers.lat),
      lng                = COALESCE(EXCLUDED.lng, producers.lng),
      phone              = COALESCE(EXCLUDED.phone, producers.phone),
      sources            = (SELECT ARRAY(SELECT DISTINCT unnest(producers.sources || EXCLUDED.sources))),
      raw                = COALESCE(EXCLUDED.raw, producers.raw),
      last_seen          = now()
    RETURNING id, (xmax = 0) AS inserted`;
  const params = [
    rec.sourceState,
    String(rec.licenseNo),
    rec.npn || null,
    rec.fullName || null,
    rec.firstName || null,
    rec.lastName || null,
    rec.entityType || null,
    Array.isArray(rec.licenseTypes) ? rec.licenseTypes : [],
    Array.isArray(rec.linesOfAuthority) ? rec.linesOfAuthority : [],
    rec.status || null,
    rec.addressLine1 || null,
    rec.addressLine2 || null,
    rec.city || null,
    rec.state || null,
    rec.zip || null,
    rec.phone || null,
    Array.isArray(rec.sources) ? rec.sources : [],
    rec.raw ? JSON.stringify(rec.raw) : null,
  ];
  const { rows } = await query(sql, params);
  return { id: rows[0].id, inserted: rows[0].inserted };
}

// -- Per-state work queue -----------------------------------------------------

// Ensure a state_progress row exists for each configured adapter and keep its
// adapter_kind current. Preserves existing status/counters (so progress survives
// redeploys). entries: [{ state, kind }].
export async function seedStateProgress(entries) {
  for (const { state, kind } of entries) {
    await query(
      `INSERT INTO state_progress (state, adapter_kind)
       VALUES ($1, $2)
       ON CONFLICT (state) DO UPDATE SET adapter_kind = EXCLUDED.adapter_kind, updated_at = now()`,
      [state, kind || null],
    );
  }
}

// Atomically claim the next state to (re)collect. Blocked-kind states are never
// claimed here (re-running them can't help until their adapter gains a source — the
// worker marks them blocked once at startup). Prefers pending/errored states, then
// the stalest successfully-collected one past the refresh window. FOR UPDATE SKIP
// LOCKED keeps it safe under multiple workers. Returns the claimed row or null.
export async function claimNextState({ states, refreshAfterDays = config.worker.refreshAfterDays } = {}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query(
      `SELECT state FROM state_progress
        WHERE ($1::text[] IS NULL OR state = ANY($1))
          AND COALESCE(adapter_kind, '') <> 'blocked'
          AND (
            status IN ('pending', 'error')
            OR (status IN ('done', 'blocked')
                AND (last_run_finished_at IS NULL
                     OR last_run_finished_at < now() - ($2 || ' days')::interval))
          )
        ORDER BY (status IN ('pending', 'error')) DESC, last_run_finished_at ASC NULLS FIRST
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [states && states.length ? states : null, String(refreshAfterDays)],
    );
    if (picked.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }
    const state = picked.rows[0].state;
    const { rows } = await client.query(
      `UPDATE state_progress
          SET status = 'running', last_run_started_at = now(), updated_at = now()
        WHERE state = $1
        RETURNING *`,
      [state],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Mark a specific state running (used by manual /run and the worker's blocked-state
// pre-mark). Returns the row.
export async function markStateRunning(state, kind) {
  const { rows } = await query(
    `INSERT INTO state_progress (state, adapter_kind, status, last_run_started_at)
     VALUES ($1, $2, 'running', now())
     ON CONFLICT (state) DO UPDATE SET
       adapter_kind = COALESCE(EXCLUDED.adapter_kind, state_progress.adapter_kind),
       status = 'running', last_run_started_at = now(), updated_at = now()
     RETURNING *`,
    [state, kind || null],
  );
  return rows[0];
}

export async function markStateDone(state, { producersUpserted = 0 } = {}) {
  await query(
    `UPDATE state_progress
        SET status = 'done', producers_upserted = $2, note = NULL, last_error = NULL,
            last_run_finished_at = now(), updated_at = now()
      WHERE state = $1`,
    [state, producersUpserted],
  );
}

export async function markStateBlocked(state, note) {
  await query(
    `INSERT INTO state_progress (state, status, note, last_run_finished_at)
     VALUES ($1, 'blocked', $2, now())
     ON CONFLICT (state) DO UPDATE SET
       status = 'blocked', note = $2, producers_upserted = 0,
       last_run_finished_at = now(), updated_at = now()`,
    [state, note ? String(note).slice(0, 2000) : null],
  );
}

export async function markStateError(state, message) {
  await query(
    `UPDATE state_progress
        SET status = 'error', last_error = $2, last_run_finished_at = now(), updated_at = now()
      WHERE state = $1`,
    [state, String(message || "").slice(0, 2000)],
  );
}

// Reset states stuck 'running' (e.g. worker killed mid-collect) back to pending so
// the sweep fully resumes on restart. Returns how many were requeued.
export async function requeueStaleRunning({ olderThanMinutes = config.worker.staleRunningMinutes } = {}) {
  const { rowCount } = await query(
    `UPDATE state_progress
        SET status = 'pending', updated_at = now()
      WHERE status = 'running'
        AND (last_run_started_at IS NULL
             OR last_run_started_at < now() - ($1 || ' minutes')::interval)`,
    [String(olderThanMinutes)],
  );
  return rowCount;
}

// -- Progress / reporting ----------------------------------------------------

// Single snapshot for /status and the progress email: totals plus a per-state row
// (with each state's live producer count and its blocked note).
export async function getProgress() {
  const { rows: aggRows } = await query(`
    SELECT
      (SELECT count(*) FROM producers)::int AS producers_total,
      (SELECT count(*) FROM producers WHERE status = 'active')::int AS producers_active,
      (SELECT count(*) FROM producers WHERE status = 'inactive')::int AS producers_inactive,
      (SELECT count(*) FROM producers WHERE lat IS NOT NULL)::int AS producers_geocoded,
      (SELECT count(DISTINCT zip) FROM producers WHERE zip IS NOT NULL)::int AS zips_covered
  `);
  const { rows: stateRows } = await query(`
    SELECT sp.state, sp.adapter_kind, sp.status, sp.note, sp.producers_upserted,
           sp.last_run_started_at, sp.last_run_finished_at, sp.last_error,
           COALESCE(pc.n, 0)::int AS producers
      FROM state_progress sp
      LEFT JOIN (SELECT source_state, count(*) AS n FROM producers GROUP BY source_state) pc
        ON pc.source_state = sp.state
     ORDER BY sp.state
  `);
  const a = aggRows[0];
  const states = stateRows.map((r) => ({
    state: r.state,
    kind: r.adapter_kind,
    status: r.status,
    note: r.note,
    producers: r.producers,
    producersUpserted: r.producers_upserted,
    lastRunStartedAt: r.last_run_started_at,
    lastRunFinishedAt: r.last_run_finished_at,
    lastError: r.last_error,
  }));
  const statesConfigured = states.length;
  const statesBlocked = states.filter((s) => s.kind === "blocked" || s.status === "blocked").length;
  return {
    producersTotal: a.producers_total,
    producersActive: a.producers_active,
    producersInactive: a.producers_inactive,
    producersGeocoded: a.producers_geocoded,
    zipsCovered: a.zips_covered,
    statesConfigured,
    statesBlocked,
    statesActive: statesConfigured - statesBlocked,
    statesWithData: states.filter((s) => s.producers > 0).length,
    statesDone: states.filter((s) => s.status === "done").length,
    statesError: states.filter((s) => s.status === "error").length,
    statesPending: states.filter((s) => s.status === "pending").length,
    statesRunning: states.filter((s) => s.status === "running").length,
    states,
  };
}

export async function logEmailReport({ recipients, progress, ok, error }) {
  await query(
    `INSERT INTO email_reports
        (recipients, producers_total, states_active, states_blocked, zips_covered, ok, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      recipients || null,
      progress?.producersTotal ?? null,
      progress?.statesActive ?? null,
      progress?.statesBlocked ?? null,
      progress?.zipsCovered ?? null,
      !!ok,
      error ? String(error).slice(0, 2000) : null,
    ],
  );
}
