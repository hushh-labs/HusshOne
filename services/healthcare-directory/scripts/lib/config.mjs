// Central config for the US healthcare provider directory. Reading env here (never
// printing values) keeps secrets out of logs. Nothing throws on import so unit tests
// can load libs without any env set — the assert* helpers throw only when a real run
// needs a value.

import path from "node:path";

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Kirkland, WA — kept as the geo origin so the shared `zips` reference table (loaded
// verbatim from the fleet's GeoNames loader) still carries dist_km_from_kirkland.
// Providers are geo-tagged by joining their practice ZIP to this table.
export const KIRKLAND = { lat: 47.6769, lng: -122.206, zip: "98033" };

export const config = {
  port: num(process.env.PORT, 8080),
  apiKey: String(process.env.SCRAPER_API_KEY || "").trim(),
  outputDir: process.env.OUTPUT_DIR || path.join(process.cwd(), "outputs"),

  // Database (Cloud SQL Postgres + PostGIS, reached via the local Cloud SQL Auth Proxy).
  db: {
    host: process.env.PGHOST || "127.0.0.1",
    port: num(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE || "healthcare",
    user: process.env.PGUSER || "healthcare",
    password: process.env.PGPASSWORD || "",
    max: num(process.env.PGPOOL_MAX, 10),
  },

  // NPPES NPI Registry — the national bulk source (PRIMARY). A monthly full-
  // replacement ZIP (~9GB unzipped, 8M+ providers) plus weekly incremental "V2"
  // files. We never hardcode a filename: discoverLatestBulkUrl() fetches the index
  // HTML and parses the newest monthly + weekly hrefs.
  nppes: {
    indexUrl: process.env.NPPES_INDEX_URL || "https://download.cms.gov/nppes/NPI_Files.html",
    baseUrl: process.env.NPPES_BASE_URL || "https://download.cms.gov/nppes/",
    // Pre-unzipped npidata_pfile CSV path (the deploy/init step unzips the monthly
    // file on the VM; local runs can point here directly). Empty => download+unzip.
    csvPath: process.env.NPPES_CSV_PATH || "",
    downloadDir: process.env.NPPES_DOWNLOAD_DIR || path.join(process.cwd(), "inputs"),
    // Rows per upsert batch when stream-parsing the CSV. Kept modest so memory stays
    // flat over the multi-GB file and each round-trip is bounded.
    batchSize: num(process.env.NPPES_BATCH_SIZE, 1000),
    userAgent: process.env.NPPES_USER_AGENT || "husshone-healthcare-directory/0.1 (ops@hushh.ai)",
    // Optional cap on rows ingested per file (0 = no cap). For smoke tests on the VM.
    maxRows: num(process.env.NPPES_MAX_ROWS, 0),
  },

  // NPI Registry API (SECONDARY, for targeted refresh/enrichment only). It caps at
  // 1200 results per query (skip 1000 + limit 200), so it CANNOT enumerate the US —
  // it exists only to refresh specific state/ZIP slices between bulk drops.
  api: {
    endpoint: process.env.NPI_API_ENDPOINT || "https://npiregistry.cms.hhs.gov/api/",
    version: process.env.NPI_API_VERSION || "2.1",
    maxLimit: 200, // hard API ceiling
    maxSkip: 1000, // hard API ceiling
    userAgent: process.env.NPI_API_USER_AGENT || "husshone-healthcare-directory/0.1 (ops@hushh.ai)",
  },

  // Worker pacing. The bulk ingest is heavy and infrequent; between ingests the
  // worker sleeps and periodically re-checks the index for a newer file.
  worker: {
    // How often to re-check the NPPES index for a newer weekly/monthly file.
    refreshCheckMs: num(process.env.HEALTHCARE_REFRESH_CHECK_MS, 24 * 60 * 60 * 1000),
    // A monthly full file is considered stale (worth re-ingesting) after this many days.
    refreshAfterDays: num(process.env.HEALTHCARE_REFRESH_AFTER_DAYS, 30),
    maxBackoffMs: num(process.env.HEALTHCARE_WORKER_MAX_BACKOFF_MS, 60 * 60 * 1000),
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
    fromName: process.env.GMAIL_FROM_NAME || "Hushh Healthcare Directory",
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
