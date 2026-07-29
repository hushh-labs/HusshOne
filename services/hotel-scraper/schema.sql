-- US hotel crawler schema (Postgres 16 + PostGIS).
-- Idempotent: safe to re-apply. Apply with:
--   psql "$DATABASE_URL" -f schema.sql

-- Never block the live workers for long on a migration: the ADD COLUMN statements
-- below take a brief ACCESS EXCLUSIVE lock, so cap the wait. If a concurrent txn
-- holds the table, fail fast (the deploy aborts and can retry) instead of queueing
-- behind — and ahead of — the running crawl/photos workers.
SET lock_timeout = '3s';

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- zips: the work queue AND the live progress ledger (the ~42k US ZIP universe).
-- Ordered by dist_km_from_kirkland so the crawler starts at Kirkland and spirals out.
-- status columns: pending | in_progress | done | error
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
  osm_status    TEXT NOT NULL DEFAULT 'pending',
  places_status TEXT NOT NULL DEFAULT 'pending',
  places_calls INT NOT NULL DEFAULT 0,
  hotels_found INT NOT NULL DEFAULT 0,
  last_error TEXT,
  last_scraped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary queue lookup: cheapest pending ZIP by distance from Kirkland.
CREATE INDEX IF NOT EXISTS zips_queue_idx ON zips (places_status, dist_km_from_kirkland);
-- Refresh lookup: oldest-scraped ZIP once the first full sweep completes.
CREATE INDEX IF NOT EXISTS zips_refresh_idx ON zips (last_scraped_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS zips_geog_gix ON zips USING GIST (geog);

-- ---------------------------------------------------------------------------
-- hotels: the collected lodging. One row per real-world hotel, keyed by a stable
-- dedup_key so OSM (free coverage) and Places (rich enrichment) merge into one row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hotels (
  id BIGSERIAL PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,          -- normalize(name)+geohash — stable across sources
  place_id TEXT UNIQUE,                     -- Google Place id (NULL for OSM-only)
  osm_id TEXT,                              -- OSM element id, e.g. "node/123" (NULL for Places-only)
  sources TEXT[] NOT NULL DEFAULT '{}',     -- {osm} | {places} | {osm,places}
  name TEXT NOT NULL,
  formatted_address TEXT,
  zip CHAR(5),                              -- the hotel's OWN zip (from its address)
  query_zip CHAR(5) REFERENCES zips(zip),   -- the zip we searched to find it (traceability)
  state CHAR(2),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  geog geography(Point, 4326) GENERATED ALWAYS AS
    (CASE WHEN lat IS NULL OR lng IS NULL THEN NULL
          ELSE ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END) STORED,
  rating REAL,
  user_ratings_total INT,
  price_level TEXT,
  phone TEXT,
  website TEXT,
  google_maps_uri TEXT,
  primary_type TEXT,
  types TEXT[],
  business_status TEXT,
  raw JSONB,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hotels_zip_idx ON hotels (zip);
CREATE INDEX IF NOT EXISTS hotels_query_zip_idx ON hotels (query_zip);
CREATE INDEX IF NOT EXISTS hotels_state_idx ON hotels (state);
CREATE INDEX IF NOT EXISTS hotels_geog_gix ON hotels USING GIST (geog);

-- ---------------------------------------------------------------------------
-- Photos (added after the first crawl). Google photos exist only for rows with a
-- place_id, so OSM-only rows are simply never queued. Two layers:
--   photo_refs   — Places photo *resource names*. A refreshable HINT only: ToS
--                  §3.2.3(b) says photo names are NOT cacheable and can expire, so
--                  the resolver always re-fetches fresh names via Place Details and
--                  never trusts these long-term (only place_id is cacheable).
--                  Free to collect: searchText already bills at the top tier, so
--                  adding places.photos to the field mask costs nothing extra.
--   photos       — resolved [{ref,uri,widthPx,heightPx,attribution}] (the paid
--                  Place Photo media resolve; uri is a googleusercontent link).
-- photos_status: pending | in_progress | done | none | error. The resolver worker
-- drains 'pending' rows that have a place_id (partial index below keeps it small).
-- ---------------------------------------------------------------------------
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS photo_refs TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS photos_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS photos_count INT NOT NULL DEFAULT 0;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS photos_fetched_at TIMESTAMPTZ;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS photos_error TEXT;

-- Resolver queue: only rows that can actually have Google photos (place_id set),
-- still waiting to be resolved. Partial predicate keeps the index tiny.
CREATE INDEX IF NOT EXISTS hotels_photos_queue_idx
  ON hotels (photos_status)
  WHERE place_id IS NOT NULL AND photos_status IN ('pending', 'in_progress');

-- Phase-2 refresh scan: oldest resolved rows first (photoUri links are not
-- permanent). Partial predicate keeps this index small too.
CREATE INDEX IF NOT EXISTS hotels_photos_refresh_idx
  ON hotels (photos_fetched_at NULLS FIRST)
  WHERE place_id IS NOT NULL AND photos_status = 'done';

-- ---------------------------------------------------------------------------
-- photo_spend: per-UTC-day ledger of PAID Place Photo media fetches. Lets the
-- resolver pause once dailyBudgetUsd is reached and the report show real dollars.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photo_spend (
  day DATE PRIMARY KEY,
  media_fetches BIGINT NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- email_reports: audit trail of every daily progress email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_reports (
  id BIGSERIAL PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipients TEXT[],
  zips_done INT,
  zips_left INT,
  hotels_total INT,
  places_calls_total INT,
  est_cost_usd NUMERIC(12, 2),
  ok BOOLEAN NOT NULL DEFAULT true,
  error TEXT
);
