-- Social-circles ("who-knows-who") relationship graph schema (Postgres 16).
-- Lives in its OWN `social` database. Idempotent: safe to re-apply. Apply with:
--   node scripts/apply-schema.mjs      (or)   psql "$DATABASE_URL" -f schema.sql
--
-- PostGIS is OPTIONAL here: the graph is derived from the source directories'
-- already-geocoded rows (zip/state), so we do not require the extension. If it is
-- available it is enabled for possible future co-location work, but nothing below
-- depends on it (the CREATE EXTENSION is best-effort in apply-schema.mjs).

-- ---------------------------------------------------------------------------
-- persons: graph NODES. Holds both people AND orgs (hotels, RIA firms). One row
-- per resolved real-world entity. `cluster_key` is a deterministic, stable key
-- computed by the resolver (name_key + a zip/org discriminator) — it is the
-- idempotency anchor so re-running a build upserts the same node instead of
-- duplicating it. `profession` bucket: healthcare|ria|insurance|hospitality|social.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persons (
  id BIGSERIAL PRIMARY KEY,
  cluster_key TEXT NOT NULL UNIQUE,        -- internal idempotency anchor (resolver output)
  canonical_name TEXT,
  name_key TEXT,                            -- normalized lower/stripped key for matching
  primary_zip CHAR(5),
  primary_state CHAR(2),
  profession TEXT,                          -- healthcare|ria|insurance|hospitality|social
  attributes JSONB NOT NULL DEFAULT '{}',
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS persons_name_key_idx ON persons (name_key);
CREATE INDEX IF NOT EXISTS persons_zip_idx      ON persons (primary_zip);
CREATE INDEX IF NOT EXISTS persons_state_idx    ON persons (primary_state);

-- ---------------------------------------------------------------------------
-- person_sources: the provenance edges from a node back to its source rows in the
-- other directories/scrapers. UNIQUE(source_vertical, source_key) makes ingest
-- idempotent and lets a rebuild re-point a source to a merged node.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_sources (
  id BIGSERIAL PRIMARY KEY,
  person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  source_vertical TEXT NOT NULL,           -- healthcare|ria|insurance|hotel|instagram|twitter|threads
  source_key TEXT NOT NULL,                -- the source row's stable id: npi|crd|license_no|dedup_key|handle
  source_ref JSONB NOT NULL DEFAULT '{}',  -- small snapshot: name, address, org, zip
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_vertical, source_key)
);

CREATE INDEX IF NOT EXISTS person_sources_person_idx   ON person_sources (person_id);
CREATE INDEX IF NOT EXISTS person_sources_vertical_idx ON person_sources (source_vertical);

-- ---------------------------------------------------------------------------
-- edges: the derived relationships between nodes. Undirected edge types are
-- normalized so src_person_id < dst_person_id (deduped by the UNIQUE below);
-- directed social edges (follow/mention) keep their direction.
-- edge_type: shared_address | same_org | same_zip_profession | name_alias
--          | social_follow | social_mention
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edges (
  id BIGSERIAL PRIMARY KEY,
  src_person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  dst_person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  evidence JSONB NOT NULL DEFAULT '{}',
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (src_person_id, dst_person_id, edge_type)
);

CREATE INDEX IF NOT EXISTS edges_src_idx  ON edges (src_person_id);
CREATE INDEX IF NOT EXISTS edges_dst_idx  ON edges (dst_person_id);
CREATE INDEX IF NOT EXISTS edges_type_idx ON edges (edge_type);

-- ---------------------------------------------------------------------------
-- build_runs: audit trail of every full rebuild pass.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS build_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  persons_upserted INT,
  edges_upserted INT,
  sources_scanned JSONB,                    -- {healthcare: 123, ria: 45, ...}
  ok BOOLEAN NOT NULL DEFAULT false,
  error TEXT
);

CREATE INDEX IF NOT EXISTS build_runs_started_idx ON build_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- email_reports: audit trail of every combined daily roll-up email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_reports (
  id BIGSERIAL PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipients TEXT[],
  metrics JSONB,                            -- the whole rendered metrics snapshot
  persons_total INT,
  edges_total INT,
  ok BOOLEAN NOT NULL DEFAULT true,
  error TEXT
);
