// Central config for the RIA directory service. Reading env here (never printing
// values) keeps secrets out of logs. Nothing throws on import so unit tests can
// load libs without any env set — the assert* helpers throw only when a real run
// needs a value.

import path from "node:path";

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Kirkland, WA — retained only because the shared ZIP loader (scripts/load-zips.mjs)
// and zip.mjs stamp a `dist_km_from_kirkland` per ZIP. RIA is a national bulk ingest,
// so nothing is ordered by this distance; it just keeps those files byte-for-byte
// shared with the sibling scraper services.
export const KIRKLAND = { lat: 47.6769, lng: -122.206, zip: "98033" };

export const config = {
  port: num(process.env.PORT, 8080),
  apiKey: String(process.env.SCRAPER_API_KEY || "").trim(),
  outputDir: process.env.OUTPUT_DIR || path.join(process.cwd(), "outputs"),

  // Database (Cloud SQL Postgres + PostGIS, reached via the local Cloud SQL Auth Proxy).
  db: {
    host: process.env.PGHOST || "127.0.0.1",
    port: num(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE || "ria",
    user: process.env.PGUSER || "directories",
    password: process.env.PGPASSWORD || "",
    max: num(process.env.PGPOOL_MAX, 10),
  },

  // SEC IAPD / Form ADV compilation feeds. These are the public national registry of
  // Registered Investment Advisers, published by the SEC as periodically-refreshed
  // compilation files. We DISCOVER the newest file names at runtime (see adv.mjs) rather
  // than hardcoding a stale filename — the primary discovery path is the reports
  // manifest JSON; an HTML scrape and a dated static-path fallback back it up.
  sec: {
    // Manifest listing the current compilation files (name/size/date). Verified live.
    manifestUrl:
      process.env.SEC_COMPILATION_MANIFEST_URL ||
      "https://reports.adviserinfo.sec.gov/reports/CompilationReports/CompilationReports.manifest.json",
    // Base for downloading a named compilation file: `${reportsBaseUrl}/${name}`.
    reportsBaseUrl:
      process.env.SEC_REPORTS_BASE_URL ||
      "https://reports.adviserinfo.sec.gov/reports/CompilationReports",
    // Human-facing index (an Angular app — usually no static links; used as a fallback).
    compilationPageUrl: process.env.SEC_COMPILATION_PAGE_URL || "https://adviserinfo.sec.gov/compilation",
    userAgent: process.env.SEC_USER_AGENT || "husshone-ria-directory/0.1 (ops@hushh.ai)",
    // Substrings that identify each feed within the manifest/HTML/static candidates.
    firmFilePattern: process.env.SEC_FIRM_FILE_PATTERN || "IA_FIRM_SEC_Feed",
    individualFilePattern: process.env.SEC_INDIVIDUAL_FILE_PATTERN || "IA_INDVL_Feed",
    downloadDir: process.env.SEC_DOWNLOAD_DIR || path.join(process.cwd(), "inputs"),
  },

  // Worker pacing. A bulk registry only refreshes periodically, so the loop mostly
  // sleeps: after a successful ingest it re-checks for a newer compilation roughly
  // monthly, with bounded backoff when the DB or SEC is unreachable.
  worker: {
    refreshAfterDays: num(process.env.RIA_REFRESH_AFTER_DAYS, 30),
    checkIntervalMs: num(process.env.RIA_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000), // 6h
    maxBackoffMs: num(process.env.RIA_WORKER_MAX_BACKOFF_MS, 60 * 60 * 1000), // 1h
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
    fromName: process.env.GMAIL_FROM_NAME || "Hushh RIA Directory",
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
