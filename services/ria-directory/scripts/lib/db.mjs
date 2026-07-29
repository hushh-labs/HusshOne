// Postgres access layer (Cloud SQL + PostGIS via the local Auth Proxy).
// One shared pool. Firm/adviser writes are idempotent upserts keyed on CRD, so a
// re-ingest of the same (or a newer) compilation merges cleanly. ingest_runs is the
// resumability + freshness ledger the worker reads to decide when to pull again.

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

// -- ZIP geo-reference -------------------------------------------------------

// Bulk-load ZIPs (from GeoNames) idempotently. Only static geo fields are refreshed
// on conflict. Returns inserted count. (Copied from the shared ZIP loader — RIA uses
// `zips` purely as a lookup to geo-tag firms/advisers, never as a work queue.)
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

// -- Firms -------------------------------------------------------------------

// Insert or merge a firm by CRD. lat/lng are geo-tagged from the firm's ZIP via a
// subselect into `zips` (NULL if the ZIP is unknown → geog stays NULL). COALESCE keeps
// existing values when an incoming feed omits a field; `sources` is unioned; first_seen
// never moves. Returns { crd, inserted } (inserted=true only on first sight).
export async function upsertFirm(rec) {
  if (!rec || rec.crd == null) return null;
  const sql = `
    INSERT INTO firms (
      crd, sec_number, firm_name, street1, street2, city, state, zip, country,
      phone, website, aum, total_employees, num_accounts, registration_status,
      lat, lng, sources, raw
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15,
      (SELECT lat FROM zips WHERE zip = $8),
      (SELECT lng FROM zips WHERE zip = $8),
      ARRAY[$16]::text[], $17::jsonb
    )
    ON CONFLICT (crd) DO UPDATE SET
      sec_number          = COALESCE(EXCLUDED.sec_number, firms.sec_number),
      firm_name           = COALESCE(EXCLUDED.firm_name, firms.firm_name),
      street1             = COALESCE(EXCLUDED.street1, firms.street1),
      street2             = COALESCE(EXCLUDED.street2, firms.street2),
      city                = COALESCE(EXCLUDED.city, firms.city),
      state               = COALESCE(EXCLUDED.state, firms.state),
      zip                 = COALESCE(EXCLUDED.zip, firms.zip),
      country             = COALESCE(EXCLUDED.country, firms.country),
      phone               = COALESCE(EXCLUDED.phone, firms.phone),
      website             = COALESCE(EXCLUDED.website, firms.website),
      aum                 = COALESCE(EXCLUDED.aum, firms.aum),
      total_employees     = COALESCE(EXCLUDED.total_employees, firms.total_employees),
      num_accounts        = COALESCE(EXCLUDED.num_accounts, firms.num_accounts),
      registration_status = COALESCE(EXCLUDED.registration_status, firms.registration_status),
      lat                 = COALESCE(EXCLUDED.lat, firms.lat),
      lng                 = COALESCE(EXCLUDED.lng, firms.lng),
      sources             = (SELECT ARRAY(SELECT DISTINCT unnest(firms.sources || EXCLUDED.sources))),
      raw                 = COALESCE(EXCLUDED.raw, firms.raw),
      last_seen           = now()
    RETURNING crd, (xmax = 0) AS inserted`;
  const params = [
    rec.crd,
    rec.secNumber || null,
    rec.firmName || null,
    rec.street1 || null,
    rec.street2 || null,
    rec.city || null,
    rec.state || null,
    rec.zip || null,
    rec.country || null,
    rec.phone || null,
    rec.website || null,
    rec.aum ?? null,
    rec.totalEmployees ?? null,
    rec.numAccounts ?? null,
    rec.registrationStatus || null,
    rec.source || "firms",
    rec.raw ? JSON.stringify(rec.raw) : null,
  ];
  const { rows } = await query(sql, params);
  return { crd: rows[0].crd, inserted: rows[0].inserted };
}

// -- Advisers ----------------------------------------------------------------

// Insert or merge an individual adviser by CRD. Geo-tagged from an address ZIP only
// when the feed carries one (many individual records have no public address).
export async function upsertAdviser(rec) {
  if (!rec || rec.crd == null) return null;
  const sql = `
    INSERT INTO advisers (
      crd, first_name, last_name, current_firm_crd, current_firm_name,
      street1, street2, city, state, zip, country, lat, lng, sources, raw
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10, $11,
      (SELECT lat FROM zips WHERE zip = $10),
      (SELECT lng FROM zips WHERE zip = $10),
      ARRAY[$12]::text[], $13::jsonb
    )
    ON CONFLICT (crd) DO UPDATE SET
      first_name        = COALESCE(EXCLUDED.first_name, advisers.first_name),
      last_name         = COALESCE(EXCLUDED.last_name, advisers.last_name),
      current_firm_crd  = COALESCE(EXCLUDED.current_firm_crd, advisers.current_firm_crd),
      current_firm_name = COALESCE(EXCLUDED.current_firm_name, advisers.current_firm_name),
      street1           = COALESCE(EXCLUDED.street1, advisers.street1),
      street2           = COALESCE(EXCLUDED.street2, advisers.street2),
      city              = COALESCE(EXCLUDED.city, advisers.city),
      state             = COALESCE(EXCLUDED.state, advisers.state),
      zip               = COALESCE(EXCLUDED.zip, advisers.zip),
      country           = COALESCE(EXCLUDED.country, advisers.country),
      lat               = COALESCE(EXCLUDED.lat, advisers.lat),
      lng               = COALESCE(EXCLUDED.lng, advisers.lng),
      sources           = (SELECT ARRAY(SELECT DISTINCT unnest(advisers.sources || EXCLUDED.sources))),
      raw               = COALESCE(EXCLUDED.raw, advisers.raw),
      last_seen         = now()
    RETURNING crd, (xmax = 0) AS inserted`;
  const params = [
    rec.crd,
    rec.firstName || null,
    rec.lastName || null,
    rec.currentFirmCrd ?? null,
    rec.currentFirmName || null,
    rec.street1 || null,
    rec.street2 || null,
    rec.city || null,
    rec.state || null,
    rec.zip || null,
    rec.country || null,
    rec.source || "individuals",
    rec.raw ? JSON.stringify(rec.raw) : null,
  ];
  const { rows } = await query(sql, params);
  return { crd: rows[0].crd, inserted: rows[0].inserted };
}

// -- Ingest ledger -----------------------------------------------------------

export async function startIngestRun({ kind, sourceFile }) {
  const { rows } = await query(
    `INSERT INTO ingest_runs (kind, source_file) VALUES ($1, $2) RETURNING id`,
    [kind, sourceFile || null],
  );
  return rows[0].id;
}

export async function finishIngestRun(id, { rowsSeen = 0, rowsUpserted = 0, ok = true, error = null } = {}) {
  await query(
    `UPDATE ingest_runs
        SET finished_at = now(),
            rows_seen = $2,
            rows_upserted = $3,
            ok = $4,
            error = $5
      WHERE id = $1`,
    [id, rowsSeen, rowsUpserted, !!ok, error ? String(error).slice(0, 2000) : null],
  );
}

// The most recent successful ingest for a kind ('firms'|'individuals'), or null.
// Drives the worker's "is a newer compilation available / is a refresh due?" decision.
export async function lastSuccessfulIngest(kind) {
  const { rows } = await query(
    `SELECT id, kind, source_file, finished_at, rows_seen, rows_upserted
       FROM ingest_runs
      WHERE kind = $1 AND ok = true AND finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1`,
    [kind],
  );
  return rows[0] || null;
}

export async function countFirms() {
  const { rows } = await query(`SELECT count(*)::bigint AS n FROM firms`);
  return Number(rows[0]?.n || 0);
}

// -- Progress / reporting ----------------------------------------------------

// Single round-trip snapshot for /status and the daily email.
export async function getProgress({ refreshAfterDays = config.worker.refreshAfterDays } = {}) {
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM firms)::bigint AS firms_total,
      (SELECT count(*) FROM firms WHERE geog IS NOT NULL)::bigint AS firms_geocoded,
      (SELECT count(*) FROM advisers)::bigint AS advisers_total,
      (SELECT count(DISTINCT state) FROM firms WHERE state IS NOT NULL)::int AS states_covered,
      (SELECT COALESCE(sum(aum), 0) FROM firms)::numeric AS total_aum,
      (SELECT count(DISTINCT zip) FROM firms WHERE zip IS NOT NULL)::int AS zips_covered,
      (SELECT count(*) FROM zips)::int AS zips_total,
      (SELECT source_file FROM ingest_runs WHERE kind='firms' AND ok ORDER BY finished_at DESC NULLS LAST LIMIT 1) AS last_firm_file,
      (SELECT finished_at FROM ingest_runs WHERE kind='firms' AND ok ORDER BY finished_at DESC NULLS LAST LIMIT 1) AS last_firm_at,
      (SELECT source_file FROM ingest_runs WHERE kind='individuals' AND ok ORDER BY finished_at DESC NULLS LAST LIMIT 1) AS last_individual_file,
      (SELECT finished_at FROM ingest_runs WHERE kind='individuals' AND ok ORDER BY finished_at DESC NULLS LAST LIMIT 1) AS last_individual_at
  `);
  const p = rows[0];
  const zipsTotal = p.zips_total || 0;
  const zipsCovered = p.zips_covered || 0;
  const pctZips = zipsTotal ? Math.round((zipsCovered / zipsTotal) * 1000) / 10 : 0;
  let nextRefreshDue = null;
  if (p.last_firm_at) {
    nextRefreshDue = new Date(new Date(p.last_firm_at).getTime() + refreshAfterDays * 24 * 60 * 60 * 1000);
  }
  return {
    firmsTotal: Number(p.firms_total),
    firmsGeocoded: Number(p.firms_geocoded),
    advisersTotal: Number(p.advisers_total),
    statesCovered: p.states_covered,
    totalAum: Number(p.total_aum),
    zipsCovered,
    zipsTotal,
    pctZips,
    lastFirmFile: p.last_firm_file || null,
    lastFirmAt: p.last_firm_at || null,
    lastIndividualFile: p.last_individual_file || null,
    lastIndividualAt: p.last_individual_at || null,
    nextRefreshDue,
  };
}

export async function logEmailReport({ recipients, progress, ok, error }) {
  await query(
    `INSERT INTO email_reports
        (recipients, firms_total, advisers_total, states_covered, total_aum, zips_covered, ok, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      recipients || null,
      progress?.firmsTotal ?? null,
      progress?.advisersTotal ?? null,
      progress?.statesCovered ?? null,
      progress?.totalAum ?? null,
      progress?.zipsCovered ?? null,
      !!ok,
      error ? String(error).slice(0, 2000) : null,
    ],
  );
}
