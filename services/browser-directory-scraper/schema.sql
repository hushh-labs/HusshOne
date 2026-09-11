-- Browser discovery control plane. The canonical directory tables remain
-- healthcare.providers, insurance.producers, ria.firms/ria.advisers, and
-- hotel_scraper.hotels. This table stores public observations until an
-- official NPI/license/CRD/place identity is verified.

CREATE TABLE IF NOT EXISTS browser_scrape_tasks (
  task_id TEXT PRIMARY KEY,
  vertical TEXT NOT NULL CHECK (vertical IN ('healthcare', 'insurance', 'advisory', 'hotel')),
  query_zip CHAR(5) NOT NULL,
  city TEXT,
  state CHAR(2),
  query TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'google_search',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  worker_id TEXT,
  lease_until TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  result_count INT NOT NULL DEFAULT 0,
  records_saved INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS browser_tasks_claim_idx
  ON browser_scrape_tasks (vertical, status, next_attempt_at, query_zip);
CREATE INDEX IF NOT EXISTS browser_tasks_lease_idx
  ON browser_scrape_tasks (lease_until)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS browser_observations (
  observation_id BIGSERIAL PRIMARY KEY,
  stable_key TEXT NOT NULL UNIQUE,
  vertical TEXT NOT NULL CHECK (vertical IN ('healthcare', 'insurance', 'advisory', 'hotel')),
  query_zip CHAR(5) NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state CHAR(2),
  postal_code CHAR(5),
  phone TEXT,
  website TEXT,
  source TEXT NOT NULL,
  source_domain TEXT,
  source_url TEXT NOT NULL,
  source_rank INT,
  categories TEXT[] NOT NULL DEFAULT '{}',
  rating NUMERIC(3, 2),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  canonical_database TEXT,
  canonical_table TEXT,
  canonical_key TEXT,
  verified_at TIMESTAMPTZ,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  crawl_count INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS browser_observations_zip_idx
  ON browser_observations (vertical, query_zip);
CREATE INDEX IF NOT EXISTS browser_observations_name_idx
  ON browser_observations (normalized_name);
CREATE INDEX IF NOT EXISTS browser_observations_domain_idx
  ON browser_observations (source_domain);

CREATE TABLE IF NOT EXISTS browser_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  vertical TEXT NOT NULL,
  cdp_port INT NOT NULL,
  profile_dir TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  current_task_id TEXT,
  last_error TEXT,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS browser_worker_heartbeat_idx
  ON browser_worker_heartbeats (heartbeat_at);
