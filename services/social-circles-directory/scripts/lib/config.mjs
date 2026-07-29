// Central config for the social-circles graph builder. Reading env here (never
// printing values) keeps secrets out of logs. Nothing throws on import so unit
// tests can load libs without any env set — the assert* helpers throw only when a
// real run needs a value.
//
// This service is a "who-knows-who" GRAPH BUILDER, not a scraper. It links
// people/orgs ACROSS the other four directory databases (healthcare, ria,
// insurance, hotel_scraper) plus the IG/X/Threads social scrapers, and writes a
// relationship graph to its OWN `social` database. Postgres cannot cross-database
// query natively, so the builder opens a SEPARATE pg Pool per source database —
// all sharing host/port/user/password via the Cloud SQL Auth Proxy on the VM,
// only the database name differs.

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const csv = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// The four SOURCE database NAMES on the shared Cloud SQL instance. Overridable as
// a positional CSV via SOURCE_DBS (order: healthcare, ria, insurance, hotel), or
// individually via SOURCE_DB_*. Note the 4th is the hotel-scraper's DB
// (`hotel_scraper`) while its graph vertical/profession is "hotel"/"hospitality".
const DEFAULT_SOURCE_DBS = ["healthcare", "ria", "insurance", "hotel_scraper"];
const sourceDbsOverride = csv(process.env.SOURCE_DBS);
const sourceDbList = sourceDbsOverride.length === 4 ? sourceDbsOverride : DEFAULT_SOURCE_DBS;

export const config = {
  port: num(process.env.PORT, 8080),
  apiKey: String(process.env.SCRAPER_API_KEY || "").trim(),

  // The graph's OWN database (Cloud SQL Postgres, reached via the local Cloud SQL
  // Auth Proxy). PostGIS optional — used only if present for co-location edges.
  db: {
    host: process.env.PGHOST || "127.0.0.1",
    port: num(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE || "social",
    user: process.env.PGUSER || "directories",
    password: process.env.PGPASSWORD || "",
    max: num(process.env.PGPOOL_MAX, 10),
  },

  // The FOUR source databases. Same host/port/user/password as `db` (same Cloud
  // SQL instance via the same proxy); only the database name differs. `role` is
  // the stable internal handle the connectors reference; `name` is the actual DB.
  sources: {
    names: {
      healthcare: process.env.SOURCE_DB_HEALTHCARE || sourceDbList[0],
      ria: process.env.SOURCE_DB_RIA || sourceDbList[1],
      insurance: process.env.SOURCE_DB_INSURANCE || sourceDbList[2],
      hotel: process.env.SOURCE_DB_HOTEL || sourceDbList[3],
    },
    // Safety cap so a huge/unexpected source table can't OOM a rebuild pass.
    // 0 = unlimited. Pagination batch size is separate.
    maxEntitiesPerSource: num(process.env.SOURCE_MAX_ENTITIES, 0),
    batchSize: num(process.env.SOURCE_BATCH_SIZE, 1000),
  },

  // Social-scraper inputs. The IG/X/Threads scrapers persist per-request scrape
  // JSON to their OWN VM disks (no shared DB), so there is nothing for this VM to
  // query. Connectors are honest STUBS: if an operator drops exported scrape JSON
  // into one of these dirs, the stub ingests it; otherwise it yields nothing.
  social: {
    instagramDir: process.env.SOCIAL_INSTAGRAM_DIR || "",
    twitterDir: process.env.SOCIAL_TWITTER_DIR || "",
    threadsDir: process.env.SOCIAL_THREADS_DIR || "",
  },

  // Builder pacing. A full rebuild pass then a sleep, forever.
  worker: {
    rebuildIntervalMs: num(process.env.GRAPH_REBUILD_INTERVAL_MS, 6 * 60 * 60 * 1000), // 6h
    maxBackoffMs: num(process.env.GRAPH_WORKER_MAX_BACKOFF_MS, 15 * 60 * 1000),
    // same_zip_profession can explode combinatorially in dense ZIPs; skip groups
    // larger than this to keep edge counts sane (0 = no cap).
    maxSameZipGroup: num(process.env.GRAPH_MAX_SAME_ZIP_GROUP, 250),
    // Off by default. When true, edges not re-derived in a pass are deleted — but
    // the builder only prunes when the pass actually produced nodes, so empty or
    // unreachable source DBs can never wipe an existing graph.
    pruneStaleEdges: String(process.env.GRAPH_PRUNE_STALE_EDGES || "").toLowerCase() === "true",
  },

  // Combined daily roll-up: the read-only DB names to count metrics from.
  report: {
    socialDb: process.env.PGDATABASE || "social",
    healthcareDb: process.env.SOURCE_DB_HEALTHCARE || sourceDbList[0],
    riaDb: process.env.SOURCE_DB_RIA || sourceDbList[1],
    insuranceDb: process.env.SOURCE_DB_INSURANCE || sourceDbList[2],
    hotelDb: process.env.SOURCE_DB_HOTEL || sourceDbList[3],
  },

  // Email (Gmail SMTP + app password — the mechanism this repo already uses in
  // src/lib/notifications/gmail.ts: GMAIL_USER + GMAIL_APP_PASSWORD via smtp.gmail.com:465).
  mail: {
    smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
    smtpPort: num(process.env.SMTP_PORT, 465),
    user: String(process.env.GMAIL_USER || "").trim(),
    // App passwords are shown with spaces ("abcd efgh ijkl mnop") — strip them.
    appPassword: String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""),
    senderEmail: (process.env.GMAIL_SENDER_EMAIL || process.env.GMAIL_USER || "").trim(),
    fromName: process.env.GMAIL_FROM_NAME || "Hushh Social Graph",
    recipients: (process.env.REPORT_RECIPIENTS || "ankit@hushh.ai,manish@hushh.ai,kushal@hushh.ai")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export function assertMailerConfig() {
  const { user, appPassword } = config.mail;
  if (!user || !appPassword) {
    throw new Error("Missing Gmail SMTP credentials (GMAIL_USER / GMAIL_APP_PASSWORD).");
  }
}
