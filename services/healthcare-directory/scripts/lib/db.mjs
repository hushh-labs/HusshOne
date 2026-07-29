// Postgres access layer (Cloud SQL + PostGIS via the local Auth Proxy). One shared
// pool. Provider writes go through upsertProvidersBatch() (ON CONFLICT (npi)), which
// geo-tags each row by LEFT JOINing its practice ZIP to the `zips` reference table.
// The `zips` loader (load-zips.mjs) is shared verbatim across the directory fleet.

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

// -- ZIP reference table -----------------------------------------------------
// (Copied verbatim from the hotel-scraper fleet loader — load-zips.mjs depends on
// this signature. Every directory keeps a `zips` geo table so records link to
// coordinates via their ZIP.)
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

// -- Providers ---------------------------------------------------------------

// Columns carried in the VALUES list, in order. lat/lng are NOT here — they are
// filled from the zips join. `source` is a single tag; `sources` becomes ARRAY[source].
const PROVIDER_COLS = [
  "npi",
  "entityType",
  "lastName",
  "firstName",
  "middleName",
  "credential",
  "organizationName",
  "primaryTaxonomyCode",
  "primaryTaxonomyDesc",
  "enumerationDate",
  "status",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "zip",
  "phone",
  "source",
  "raw",
];

// Batch upsert providers. Each record's practice ZIP is LEFT JOINed to `zips` so
// lat/lng (and thus the generated geog point) come from the ZIP centroid. Idempotent
// on (npi): re-ingesting a monthly/weekly file overwrites the mutable fields, unions
// `sources`, and bumps last_seen; first_seen is never moved. Returns rows inserted
// (as opposed to updated). Skips records without a valid npi.
export async function upsertProvidersBatch(records) {
  const recs = (records || []).filter((r) => r && /^\d{10}$/.test(String(r.npi || "")));
  if (!recs.length) return { upserted: 0, inserted: 0 };

  const width = PROVIDER_COLS.length;
  const params = [];
  const tuples = recs.map((r, i) => {
    const base = i * width;
    params.push(
      r.npi,
      r.entityType || null,
      r.lastName || null,
      r.firstName || null,
      r.middleName || null,
      r.credential || null,
      r.organizationName || null,
      r.primaryTaxonomyCode || null,
      r.primaryTaxonomyDesc || null,
      r.enumerationDate || null,
      r.status || null,
      r.addressLine1 || null,
      r.addressLine2 || null,
      r.city || null,
      r.state || null,
      r.zip || null,
      r.phone || null,
      r.source || "nppes_bulk",
      r.raw ? JSON.stringify(r.raw) : null,
    );
    const ph = Array.from({ length: width }, (_, k) => `$${base + k + 1}`);
    return `(${ph.join(",")})`;
  });

  // v(...) names each VALUES column; parameters arrive as text (unknown type), so we
  // cast where the target column is non-text (date/jsonb). lat/lng come from the join.
  const sql = `
    INSERT INTO providers (
      npi, entity_type, last_name, first_name, middle_name, credential,
      organization_name, primary_taxonomy_code, primary_taxonomy_desc,
      enumeration_date, status, address_line1, address_line2, city, state, zip,
      phone, lat, lng, sources, raw
    )
    SELECT
      v.npi, v.entity_type, v.last_name, v.first_name, v.middle_name, v.credential,
      v.organization_name, v.primary_taxonomy_code, v.primary_taxonomy_desc,
      v.enumeration_date::date, v.status, v.address_line1, v.address_line2, v.city,
      v.state, v.zip, v.phone, z.lat, z.lng, ARRAY[v.source]::text[], v.raw::jsonb
    FROM ( VALUES ${tuples.join(", ")} ) AS v(
      npi, entity_type, last_name, first_name, middle_name, credential,
      organization_name, primary_taxonomy_code, primary_taxonomy_desc,
      enumeration_date, status, address_line1, address_line2, city, state, zip,
      phone, source, raw
    )
    LEFT JOIN zips z ON z.zip = v.zip
    ON CONFLICT (npi) DO UPDATE SET
      entity_type           = EXCLUDED.entity_type,
      last_name             = EXCLUDED.last_name,
      first_name            = EXCLUDED.first_name,
      middle_name           = EXCLUDED.middle_name,
      credential            = EXCLUDED.credential,
      organization_name     = EXCLUDED.organization_name,
      primary_taxonomy_code = EXCLUDED.primary_taxonomy_code,
      primary_taxonomy_desc = COALESCE(EXCLUDED.primary_taxonomy_desc, providers.primary_taxonomy_desc),
      enumeration_date      = COALESCE(EXCLUDED.enumeration_date, providers.enumeration_date),
      status                = EXCLUDED.status,
      address_line1         = EXCLUDED.address_line1,
      address_line2         = EXCLUDED.address_line2,
      city                  = EXCLUDED.city,
      state                 = EXCLUDED.state,
      zip                   = EXCLUDED.zip,
      phone                 = EXCLUDED.phone,
      lat                   = EXCLUDED.lat,
      lng                   = EXCLUDED.lng,
      sources               = (SELECT ARRAY(SELECT DISTINCT unnest(providers.sources || EXCLUDED.sources))),
      raw                   = COALESCE(EXCLUDED.raw, providers.raw),
      last_seen             = now()
    RETURNING (xmax = 0) AS inserted`;

  const { rows } = await query(sql, params);
  return { upserted: rows.length, inserted: rows.filter((o) => o.inserted).length };
}

// Convenience single-record upsert (used by the API refresh path).
export async function upsertProvider(rec) {
  return upsertProvidersBatch([rec]);
}

// -- Ingest run bookkeeping (resumability) -----------------------------------

export async function startIngestRun({ kind, sourceFile }) {
  const { rows } = await query(
    `INSERT INTO ingest_runs (kind, source_file, started_at, ok)
     VALUES ($1, $2, now(), false) RETURNING id`,
    [kind, sourceFile || null],
  );
  return rows[0].id;
}

export async function finishIngestRun(id, { rowsSeen = 0, rowsUpserted = 0, ok = true, error = null } = {}) {
  await query(
    `UPDATE ingest_runs
        SET finished_at = now(), rows_seen = $2, rows_upserted = $3, ok = $4, error = $5
      WHERE id = $1`,
    [id, rowsSeen, rowsUpserted, !!ok, error ? String(error).slice(0, 2000) : null],
  );
}

// Has this exact source file already been ingested successfully? Drives resumability
// so restarts skip files already applied.
export async function isFileIngested(sourceFile) {
  if (!sourceFile) return false;
  const { rows } = await query(
    `SELECT 1 FROM ingest_runs WHERE source_file = $1 AND ok = true LIMIT 1`,
    [sourceFile],
  );
  return rows.length > 0;
}

// The most recent successful bulk/weekly ingest (for "last ingest" reporting).
export async function getLastIngest() {
  const { rows } = await query(
    `SELECT kind, source_file, finished_at, rows_upserted
       FROM ingest_runs
      WHERE ok = true AND kind IN ('bulk', 'weekly')
      ORDER BY finished_at DESC NULLS LAST
      LIMIT 1`,
  );
  return rows[0] || null;
}

// -- Progress / reporting ----------------------------------------------------

// Snapshot for /status and the daily email. topSpecialties is a small GROUP BY —
// acceptable for a daily/loopback read (backed by the primary_taxonomy_code index).
export async function getProgress({ topN = 5 } = {}) {
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM providers)::bigint AS providers_total,
      (SELECT count(*) FROM providers WHERE entity_type = 'individual')::bigint AS providers_individual,
      (SELECT count(*) FROM providers WHERE entity_type = 'organization')::bigint AS providers_organization,
      (SELECT count(*) FROM providers WHERE lat IS NOT NULL)::bigint AS providers_geocoded,
      (SELECT count(DISTINCT state) FROM providers WHERE state IS NOT NULL)::int AS states_covered,
      (SELECT count(DISTINCT zip) FROM providers WHERE zip IS NOT NULL)::int AS zips_with_providers,
      (SELECT count(*) FROM zips)::int AS zips_total
  `);
  const p = rows[0];

  const { rows: specialties } = await query(
    `SELECT
        COALESCE(primary_taxonomy_desc, primary_taxonomy_code, '(unspecified)') AS specialty,
        count(*)::bigint AS n
       FROM providers
      WHERE primary_taxonomy_code IS NOT NULL
      GROUP BY 1
      ORDER BY n DESC
      LIMIT $1`,
    [topN],
  );

  const last = await getLastIngest();

  const zipsTotal = p.zips_total || 0;
  const zipsWith = p.zips_with_providers || 0;
  const pctZipsCovered = zipsTotal ? Math.round((zipsWith / zipsTotal) * 1000) / 10 : 0;

  // Next refresh is due refreshAfterDays after the last successful ingest.
  let nextRefreshDue = null;
  if (last?.finished_at) {
    const due = new Date(last.finished_at);
    due.setDate(due.getDate() + config.worker.refreshAfterDays);
    nextRefreshDue = due.toISOString();
  }

  return {
    providersTotal: Number(p.providers_total),
    providersIndividual: Number(p.providers_individual),
    providersOrganization: Number(p.providers_organization),
    providersGeocoded: Number(p.providers_geocoded),
    statesCovered: p.states_covered,
    zipsWithProviders: zipsWith,
    zipsTotal,
    pctZipsCovered,
    topSpecialties: specialties.map((s) => ({ specialty: s.specialty, count: Number(s.n) })),
    lastIngestFile: last?.source_file || null,
    lastIngestAt: last?.finished_at ? new Date(last.finished_at).toISOString() : null,
    lastIngestKind: last?.kind || null,
    nextRefreshDue,
  };
}

export async function logEmailReport({ recipients, progress, ok, error }) {
  await query(
    `INSERT INTO email_reports
        (recipients, providers_total, zips_covered, zips_total, states_covered, last_ingest_file, ok, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      recipients || null,
      progress?.providersTotal ?? null,
      progress?.zipsWithProviders ?? null,
      progress?.zipsTotal ?? null,
      progress?.statesCovered ?? null,
      progress?.lastIngestFile ?? null,
      !!ok,
      error ? String(error).slice(0, 2000) : null,
    ],
  );
}
