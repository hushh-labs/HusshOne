-- Hushh RIA (Registered Investment Adviser) directory schema (Postgres 16 + PostGIS).
-- Bulk-ingest of the SEC Form ADV / IAPD compilation feeds (national registry).
-- Idempotent: safe to re-apply. Apply with:
--   psql "$DATABASE_URL" -f schema.sql   (or: node scripts/apply-schema.mjs)

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- zips: a pure geo-reference table (the ~42k US ZIP universe from GeoNames).
-- Firms/advisers link their ZIP to coordinates via this table. There is NO
-- per-ZIP crawl here (RIA is a bulk registry ingest) — this is a lookup only.
-- The dist_km_from_kirkland column is carried over from the shared ZIP loader
-- (unused for ordering here) so scripts/load-zips.mjs stays byte-for-byte shared.
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
-- firms: SEC-registered investment adviser firms (Form ADV firm feed).
-- Keyed by the firm/organization CRD. Coordinates are geo-tagged from the firm's
-- main-office ZIP by joining `zips` at upsert time; geog is derived from lat/lng.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS firms (
  crd BIGINT PRIMARY KEY,                    -- firm / organization CRD
  sec_number TEXT,                           -- SEC file number, e.g. "801-12345"
  firm_name TEXT,                            -- legal name / primary business name
  street1 TEXT,
  street2 TEXT,
  city TEXT,
  state CHAR(2),
  zip CHAR(5),
  country TEXT,
  phone TEXT,
  website TEXT,
  aum NUMERIC(20, 2),                        -- regulatory assets under management
  total_employees INT,
  num_accounts BIGINT,
  registration_status TEXT,
  lat DOUBLE PRECISION,                      -- from zips join on the firm's ZIP
  lng DOUBLE PRECISION,
  geog geography(Point, 4326) GENERATED ALWAYS AS
    (CASE WHEN lat IS NULL OR lng IS NULL THEN NULL
          ELSE ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END) STORED,
  sources TEXT[] NOT NULL DEFAULT '{}',      -- which feed(s) touched this row
  raw JSONB,                                 -- the full source row, header->value
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS firms_zip_idx ON firms (zip);
CREATE INDEX IF NOT EXISTS firms_state_idx ON firms (state);
CREATE INDEX IF NOT EXISTS firms_name_idx ON firms (firm_name);
CREATE INDEX IF NOT EXISTS firms_geog_gix ON firms USING GIST (geog);

-- ---------------------------------------------------------------------------
-- advisers: individual investment adviser representatives (Form ADV individual
-- feed). Keyed by the individual CRD. current_firm_crd loosely references
-- firms.crd (not enforced — the individual feed can arrive before the firm one).
-- Geo-tagged from an address ZIP only when the feed carries one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advisers (
  crd BIGINT PRIMARY KEY,                    -- individual CRD
  first_name TEXT,
  last_name TEXT,
  current_firm_crd BIGINT,                   -- FK-ish to firms.crd (nullable)
  current_firm_name TEXT,
  street1 TEXT,
  street2 TEXT,
  city TEXT,
  state CHAR(2),
  zip CHAR(5),
  country TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  geog geography(Point, 4326) GENERATED ALWAYS AS
    (CASE WHEN lat IS NULL OR lng IS NULL THEN NULL
          ELSE ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END) STORED,
  sources TEXT[] NOT NULL DEFAULT '{}',
  raw JSONB,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS advisers_firm_crd_idx ON advisers (current_firm_crd);
CREATE INDEX IF NOT EXISTS advisers_last_name_idx ON advisers (last_name);
CREATE INDEX IF NOT EXISTS advisers_state_idx ON advisers (state);
CREATE INDEX IF NOT EXISTS advisers_geog_gix ON advisers USING GIST (geog);

-- ---------------------------------------------------------------------------
-- ingest_runs: one row per feed ingest attempt — the resumability + freshness
-- ledger. The worker uses the latest ok run per kind to decide whether a newer
-- compilation should be pulled, and to report "last ingest file + timestamp".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                        -- 'firms' | 'individuals'
  source_file TEXT,                          -- the compilation file name ingested
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  rows_seen BIGINT NOT NULL DEFAULT 0,
  rows_upserted BIGINT NOT NULL DEFAULT 0,
  ok BOOLEAN NOT NULL DEFAULT false,
  error TEXT
);

CREATE INDEX IF NOT EXISTS ingest_runs_kind_idx ON ingest_runs (kind, finished_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- email_reports: audit trail of every daily progress email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_reports (
  id BIGSERIAL PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipients TEXT[],
  firms_total BIGINT,
  advisers_total BIGINT,
  states_covered INT,
  total_aum NUMERIC(20, 2),
  zips_covered INT,
  ok BOOLEAN NOT NULL DEFAULT true,
  error TEXT
);
