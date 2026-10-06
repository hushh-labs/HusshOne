// Central config for the US hotel crawler. Reading env here (never printing values)
// keeps secrets out of logs. Nothing throws on import so unit tests can load libs
// without any env set — the assert* helpers throw only when a real run needs a value.

import path from "node:path";

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Integer clamp for config that has a safe operating range — a fat-fingered env
// var (HOTEL_PHOTOS_MAX_PER_HOTEL=300) can't quietly multiply paid-API spend.
const clampInt = (value, lo, hi) => Math.max(lo, Math.min(hi, Math.round(value)));

// Kirkland, WA — the crawl origin. The work queue is ordered by great-circle
// distance from this point, so ZIP 98033 (dist ≈ 0) is scraped first.
export const KIRKLAND = { lat: 47.6769, lng: -122.206, zip: "98033" };

export const config = {
  port: num(process.env.PORT, 8080),
  apiKey: String(process.env.SCRAPER_API_KEY || "").trim(),
  outputDir: process.env.OUTPUT_DIR || path.join(process.cwd(), "outputs"),

  // Database (Cloud SQL Postgres + PostGIS, reached via the local Cloud SQL Auth Proxy).
  db: {
    host: process.env.PGHOST || "127.0.0.1",
    port: num(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE || "hotel_scraper",
    user: process.env.PGUSER || "hotel_scraper",
    password: process.env.PGPASSWORD || "",
    max: num(process.env.PGPOOL_MAX, 10),
  },

  // Google Places API (New) — enrichment layer.
  places: {
    apiKey: String(process.env.PLACES_API_KEY || "").trim(),
    endpoint: "https://places.googleapis.com/v1/places:searchText",
    // Place Details (GET places/{id}) and Place Photo media share the same host.
    detailsEndpoint: "https://places.googleapis.com/v1/places",
    // Enterprise-tier Text Search returns everything in one call, so we bill at the
    // top tier. Overridable so the daily email cost estimate stays accurate.
    costPerCallUsd: num(process.env.PLACES_COST_PER_CALL_USD, 0.035),
    maxPages: num(process.env.PLACES_MAX_PAGES, 3),
    pageSize: num(process.env.PLACES_PAGE_SIZE, 20),
  },

  // Photo resolver (photos-worker.mjs). Google photos exist only for rows with a
  // place_id. photo_refs come free with the searchText field mask; this resolver
  // fills in refs for pre-existing rows (Place Details, free IDs-Only tier) and
  // turns the top few refs into usable image URLs (Place Photo media — the PAID
  // part, ~$7 per 1000 successful fetches).
  //
  // Cost reality (surfaced in the daily report, capped by dailyBudgetUsd):
  //   • one-time backfill of the ~13k place_id rows × maxPerHotel ≈ $276.
  //   • refreshAfterDays re-resolves aged URLs → a RECURRING ~$276 per cycle
  //     (≈ $330/mo at 25-day cycles). Raise refreshAfterDays to spend less; the
  //     dailyBudgetUsd ceiling stops any misconfig from ever running away.
  photos: {
    enabled: String(process.env.HOTEL_PHOTOS_ENABLED ?? "true").toLowerCase() !== "false",
    // URLs resolved per hotel — each is a paid media fetch. Clamped 0..10.
    maxPerHotel: clampInt(num(process.env.HOTEL_PHOTOS_MAX_PER_HOTEL, 3), 0, 10),
    maxWidthPx: clampInt(num(process.env.HOTEL_PHOTOS_MAX_WIDTH_PX, 1200), 1, 4800),
    batchSize: clampInt(num(process.env.HOTEL_PHOTOS_BATCH_SIZE, 25), 1, 200),
    gapMs: Math.max(0, num(process.env.HOTEL_PHOTOS_GAP_MS, 200)),   // pause between hotels
    // Re-resolve URLs older than this many days (photoUri links are not permanent).
    // Floored at 7 so a typo can't turn refresh into a per-run re-bill.
    refreshAfterDays: Math.max(7, num(process.env.HOTEL_PHOTOS_REFRESH_AFTER_DAYS, 25)),
    // Hard ceiling: the worker pauses for the rest of the UTC day once this much has
    // been spent on paid media fetches. 0 = no cap (explicit "go fast" opt-in).
    dailyBudgetUsd: Math.max(0, num(process.env.HOTEL_PHOTOS_DAILY_BUDGET_USD, 300)),
    // Give up on one hotel's 429/RESOURCE_EXHAUSTED after this many retries (row ->
    // 'error', requeued later) so sustained throttling can't wedge the worker.
    maxAttempts: clampInt(num(process.env.HOTEL_PHOTOS_MAX_ATTEMPTS, 6), 1, 20),
    // Paid Place Photo media cost (USD / 1000 successful fetches) — drives the spend
    // ledger, the daily-budget ceiling, and the report's spend line.
    mediaCostPer1k: num(process.env.PLACES_PHOTO_COST_PER_1K, 7),
  },

  // OpenStreetMap — free full-coverage layer via the Overpass API.
  osm: {
    endpoint: process.env.OVERPASS_ENDPOINT || "https://overpass-api.de/api/interpreter",
    userAgent: process.env.OSM_USER_AGENT || "husshone-hotel-scraper/0.1 (ops@hushh.ai)",
    timeoutSec: num(process.env.OVERPASS_TIMEOUT_SEC, 180),
  },

  // Worker pacing. "No cap" on spend, but we still cooperate with API quotas: a tiny
  // gap between ZIPs and exponential backoff on 429 keep us from self-inflicting blocks.
  worker: {
    zipGapMs: num(process.env.HOTEL_WORKER_ZIP_GAP_MS, 250),
    refreshAfterDays: num(process.env.HOTEL_REFRESH_AFTER_DAYS, 30),
    maxBackoffMs: num(process.env.HOTEL_WORKER_MAX_BACKOFF_MS, 60_000),
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
    fromName: process.env.GMAIL_FROM_NAME || "Hushh Hotel Crawler",
    recipients: (process.env.REPORT_RECIPIENTS || "ankit@hushh.ai,manish@hushh.ai,kushal@hushh.ai")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export function assertPlacesKey() {
  if (!config.places.apiKey) {
    throw new Error("PLACES_API_KEY is not set — required for Places enrichment.");
  }
}

export function assertMailerConfig() {
  const { user, appPassword } = config.mail;
  if (!user || !appPassword) {
    throw new Error("Missing Gmail SMTP credentials (GMAIL_USER / GMAIL_APP_PASSWORD).");
  }
}
