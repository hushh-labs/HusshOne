// Central config for the insurance producer directory. Reading env here (never
// printing values) keeps secrets out of logs. Nothing throws on import so unit
// tests can load libs without any env set — the assert* helpers throw only when a
// real run needs a value.

import path from "node:path";

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Retained from the shared GeoNames ZIP loader (scripts/lib/zip.mjs +
// scripts/load-zips.mjs are copied verbatim from the fleet). The ZIP universe is
// only a geo-reference table here (producers are geo-tagged by ZIP centroid), so
// the distance-from-Kirkland ordering is unused — kept solely so the loader stays
// byte-for-byte identical across services.
export const KIRKLAND = { lat: 47.6769, lng: -122.206, zip: "98033" };

export const config = {
  port: num(process.env.PORT, 8080),
  apiKey: String(process.env.SCRAPER_API_KEY || "").trim(),
  outputDir: process.env.OUTPUT_DIR || path.join(process.cwd(), "outputs"),

  // Database (Cloud SQL Postgres + PostGIS, reached via the local Cloud SQL Auth Proxy).
  db: {
    host: process.env.PGHOST || "127.0.0.1",
    port: num(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE || "insurance",
    user: process.env.PGUSER || "insurance",
    password: process.env.PGPASSWORD || "",
    max: num(process.env.PGPOOL_MAX, 10),
  },

  // Target states this service collects, in run order. Each must have a registered
  // adapter (scripts/lib/adapters/); states without an accessible free source are
  // wired as `blocked` stubs (see the README data-source table). Override with
  // INSURANCE_STATES="TX,WA" to narrow the sweep.
  states: (process.env.INSURANCE_STATES || "WA,CA,TX,FL,NY")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  // Socrata open-data client (data.texas.gov et al.). An app token is optional —
  // it only raises the anonymous throttling ceiling; the datasets are public.
  socrata: {
    appToken: String(process.env.SOCRATA_APP_TOKEN || "").trim(),
    pageSize: num(process.env.SOCRATA_PAGE_SIZE, 50000), // Socrata max rows/request
    // Cap per-state records (e.g. for local smoke runs). Infinity = full dataset.
    maxRecords: num(process.env.INSURANCE_MAX_RECORDS_PER_STATE, Infinity),
  },

  // Worker pacing. A small gap between states plus exponential backoff on 429/5xx
  // keeps us a polite open-data citizen; state_progress makes the sweep resumable.
  worker: {
    stateGapMs: num(process.env.INSURANCE_WORKER_STATE_GAP_MS, 1000),
    refreshAfterDays: num(process.env.INSURANCE_REFRESH_AFTER_DAYS, 7),
    maxBackoffMs: num(process.env.INSURANCE_WORKER_MAX_BACKOFF_MS, 60_000),
    staleRunningMinutes: num(process.env.INSURANCE_STALE_RUNNING_MINUTES, 180),
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
    fromName: process.env.GMAIL_FROM_NAME || "Hushh Insurance Directory",
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
