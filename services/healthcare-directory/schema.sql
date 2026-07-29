-- US healthcare provider directory schema (Postgres 16 + PostGIS).
-- Idempotent: safe to re-apply. Apply with:
--   psql "$DATABASE_URL" -f schema.sql   (or: node scripts/apply-schema.mjs)

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- zips: the ~42k US ZIP geo-reference table (loaded from the GeoNames US export,
-- the same loader the whole directory fleet shares). Providers are geo-tagged by
-- LEFT JOINing their practice ZIP to this table for lat/lng. dist_km_from_kirkland
-- is kept for parity with the fleet (Kirkland, WA is the shared geo origin).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zips (
  zip CHAR(5) PRIMARY KEY,
  city TEXT,
  state CHAR(2),
  county TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  geog geography(Point, 4326) GENERATED ALWAYS AS
    (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,
  dist_km_from_kirkland DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zips_state_idx ON zips (state);
CREATE INDEX IF NOT EXISTS zips_geog_gix ON zips USING GIST (geog);

-- ---------------------------------------------------------------------------
-- providers: the collected NPPES providers. One row per NPI (the national key).
-- The monthly bulk file is the source of truth; weekly files and the NPI API
-- upsert deltas onto the same rows (ON CONFLICT (npi)). Practice-location address
-- only (never the mailing address). lat/lng come from the zips join, so geog is a
-- ZIP-centroid point — good enough for state/ZIP/radius rollups.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS providers (
  npi CHAR(10) PRIMARY KEY,
  entity_type TEXT,                          -- 'individual' (code 1) | 'organization' (code 2)
  last_name TEXT,
  first_name TEXT,
  middle_name TEXT,
  credential TEXT,
  organization_name TEXT,
  primary_taxonomy_code TEXT,                -- NUCC taxonomy code
  primary_taxonomy_desc TEXT,               -- human specialty (curated map / API-supplied)
  enumeration_date DATE,
  status TEXT,                              -- 'active' | 'deactivated'
  address_line1 TEXT,                       -- Provider Business Practice Location Address
  address_line2 TEXT,
  city TEXT,
  state CHAR(2),
  zip CHAR(5),                              -- practice ZIP (NOT FK: territory/APO ZIPs may be absent from zips)
  phone TEXT,
  lat DOUBLE PRECISION,                     -- filled from zips centroid via the upsert join
  lng DOUBLE PRECISION,
  geog geography(Point, 4326) GENERATED ALWAYS AS
    (CASE WHEN lat IS NULL OR lng IS NULL THEN NULL
          ELSE ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END) STORED,
  sources TEXT[] NOT NULL DEFAULT '{}',     -- {nppes_bulk} | {nppes_weekly} | {npi_api} | unions
  raw JSONB,                                -- full API payload for API-enriched rows (NULL for bulk)
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS providers_zip_idx ON providers (zip);
CREATE INDEX IF NOT EXISTS providers_state_idx ON providers (state);
CREATE INDEX IF NOT EXISTS providers_taxonomy_idx ON providers (primary_taxonomy_code);
CREATE INDEX IF NOT EXISTS providers_entity_type_idx ON providers (entity_type);
CREATE INDEX IF NOT EXISTS providers_geog_gix ON providers USING GIST (geog);

-- ---------------------------------------------------------------------------
-- ingest_runs: one row per bulk/weekly/api ingest attempt. Drives resumability
-- (a restart skips any source_file already recorded ok=true) and powers the
-- "last successful ingest" / "next refresh due" reporting.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                       -- 'bulk' | 'weekly' | 'api'
  source_file TEXT,                         -- the NPPES zip/csv filename (or API slice label)
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  rows_seen BIGINT NOT NULL DEFAULT 0,
  rows_upserted BIGINT NOT NULL DEFAULT 0,
  ok BOOLEAN NOT NULL DEFAULT false,
  error TEXT
);

CREATE INDEX IF NOT EXISTS ingest_runs_file_ok_idx ON ingest_runs (source_file, ok);
CREATE INDEX IF NOT EXISTS ingest_runs_finished_idx ON ingest_runs (finished_at DESC);

-- ---------------------------------------------------------------------------
-- email_reports: audit trail of every daily progress email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_reports (
  id BIGSERIAL PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipients TEXT[],
  providers_total BIGINT,
  zips_covered INT,
  zips_total INT,
  states_covered INT,
  last_ingest_file TEXT,
  ok BOOLEAN NOT NULL DEFAULT true,
  error TEXT
);
