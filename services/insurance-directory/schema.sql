-- Insurance producer directory schema (Postgres 16 + PostGIS).
-- Idempotent: safe to re-apply. Apply with:
--   psql "$DATABASE_URL" -f schema.sql

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- zips: geo-reference table (the ~42k US ZIP universe from the GeoNames export).
-- Producers are geo-tagged by matching their mailing ZIP to this table's centroid.
-- Loaded verbatim by the shared fleet loader (scripts/load-zips.mjs), which also
-- writes dist_km_from_kirkland; that column is UNUSED here (there is no distance-
-- ordered crawl) but kept so the loader stays byte-for-byte identical across services.
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
-- producers: the collected licensees. One row per (source_state, license_no) — the
-- regulator (state Department of Insurance) that issued the license plus its license
-- number. A producer licensed in several states appears once per state, because that
-- is how each state DOI dataset models it; the NPN (National Producer Number) is the
-- cross-state identity when a source publishes it.
--   entity_type: 'individual' | 'agency'
--   status:      'active' | 'inactive' | NULL (unknown)
-- state/zip are the licensee's OWN mailing address (often out-of-state — a state DOI
-- licenses producers nationwide); lat/lng are the centroid of `zip` from `zips`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS producers (
  id BIGSERIAL PRIMARY KEY,
  source_state CHAR(2) NOT NULL,
  license_no TEXT NOT NULL,
  npn TEXT,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  entity_type TEXT,
  license_types TEXT[] NOT NULL DEFAULT '{}',
  lines_of_authority TEXT[] NOT NULL DEFAULT '{}',
  status TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state CHAR(2),
  zip CHAR(5),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  geog geography(Point, 4326) GENERATED ALWAYS AS
    (CASE WHEN lat IS NULL OR lng IS NULL THEN NULL
          ELSE ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END) STORED,
  phone TEXT,
  sources TEXT[] NOT NULL DEFAULT '{}',
  raw JSONB,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_state, license_no)
);

CREATE INDEX IF NOT EXISTS producers_source_state_idx ON producers (source_state);
CREATE INDEX IF NOT EXISTS producers_zip_idx ON producers (zip);
CREATE INDEX IF NOT EXISTS producers_state_idx ON producers (state);
CREATE INDEX IF NOT EXISTS producers_npn_idx ON producers (npn);
CREATE INDEX IF NOT EXISTS producers_status_idx ON producers (status);
CREATE INDEX IF NOT EXISTS producers_geog_gix ON producers USING GIST (geog);

-- ---------------------------------------------------------------------------
-- state_progress: the per-state work queue AND live ledger. One row per configured
-- target state (see config.states). The worker claims a state, runs its adapter,
-- upserts producers, and stamps the outcome here so the sweep is resumable.
--   adapter_kind: download | api | search | blocked
--   status:       pending | running | done | blocked | error
-- `note` explains a blocked state (why, and the path to unblock it).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS state_progress (
  state CHAR(2) PRIMARY KEY,
  adapter_kind TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  producers_upserted INT NOT NULL DEFAULT 0,
  last_run_started_at TIMESTAMPTZ,
  last_run_finished_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS state_progress_status_idx ON state_progress (status);

-- ---------------------------------------------------------------------------
-- email_reports: audit trail of every progress email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_reports (
  id BIGSERIAL PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipients TEXT[],
  producers_total INT,
  states_active INT,
  states_blocked INT,
  zips_covered INT,
  ok BOOLEAN NOT NULL DEFAULT true,
  error TEXT
);
