#!/usr/bin/env node
// Combined hourly roll-up email across ALL FIVE Hushh directory verticals plus the
// derived social-circles graph. This service OWNS the cross-vertical report because
// it is the only one with (read-only) reach into every database.
//
// It opens a short-lived read-only pool per source database, counts each
// directory's primary table, folds in this graph's own node/edge stats, renders one
// HTML summary, emails the ops recipients via the Gmail SMTP mailer, and audits the
// send to email_reports in `social`. DEGRADES GRACEFULLY: a missing/empty source DB
// shows "unavailable" instead of failing the whole report. Run on a systemd timer.
//
// Usage:
//   node scripts/report.mjs              # build + send + log
//   node scripts/report.mjs --dry-run    # build + print to stdout, no send, no log
//   node scripts/report.mjs --to a@b.com # override recipients (comma-separated)

import { config } from "./lib/config.mjs";
import { getGraphStats, logEmailReport, makeSourcePool, closePool } from "./lib/db.mjs";
import { sendGmailEmail } from "./lib/mailer.mjs";
import { buildCombinedReport } from "./lib/report-render.mjs";

const log = (event, extra = {}) => console.log(JSON.stringify({ event, ...extra }));

function parseArgs(argv) {
  const args = { dryRun: false, to: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--to") args.to = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

// Count a single table; returns null (not throw) if the table/db is absent.
async function countTable(pool, table) {
  if (!IDENT_RE.test(table)) return null;
  try {
    const { rows } = await pool.query(`SELECT count(*)::bigint AS n FROM ${table}`);
    return Number(rows[0].n);
  } catch (err) {
    log("report.count_unavailable", { table, code: err.code || null });
    return null;
  }
}

// Sum counts across one or more candidate tables in a source DB. `available` is true
// if ANY candidate table returned a count.
async function countSource(dbName, tables) {
  const pool = makeSourcePool(dbName);
  try {
    let total = null;
    for (const t of tables) {
      const n = await countTable(pool, t);
      if (n != null) total = (total || 0) + n;
    }
    return { available: total != null, count: total };
  } finally {
    await pool.end().catch(() => {});
  }
}

async function collectMetrics() {
  // Graph stats from our own DB (empty graph is fine; a hard failure -> zeros).
  let graph;
  try {
    graph = await getGraphStats();
  } catch (err) {
    log("report.graph_stats_error", { message: err.message });
    graph = {
      personsTotal: 0,
      edgesTotal: 0,
      sourcesTotal: 0,
      personsByProfession: {},
      edgesByType: {},
      sourcesByVertical: {},
      lastBuild: null,
    };
  }

  const names = config.report;
  const [healthcare, ria, insurance, hotel] = await Promise.all([
    countSource(names.healthcareDb, [process.env.HEALTHCARE_TABLE || "providers"]),
    countSource(names.riaDb, [process.env.RIA_ADVISERS_TABLE || "advisers", process.env.RIA_FIRMS_TABLE || "firms"]),
    countSource(names.insuranceDb, [process.env.INSURANCE_TABLE || "producers"]),
    countSource(names.hotelDb, [process.env.HOTEL_TABLE || "hotels"]),
  ]);

  // Social has no centrally queryable store (per-VM scrape JSON). Report how many
  // social nodes the graph has actually linked instead of pretending to count a DB.
  const s = graph.sourcesByVertical || {};
  const socialLinked = (s.instagram || 0) + (s.twitter || 0) + (s.threads || 0);

  const verticals = [
    { key: "healthcare", label: "Healthcare providers", db: names.healthcareDb, ...healthcare },
    { key: "ria", label: "RIA advisers + firms", db: names.riaDb, ...ria },
    { key: "insurance", label: "Insurance producers", db: names.insuranceDb, ...insurance },
    { key: "hotel", label: "Hotels", db: names.hotelDb, ...hotel },
    {
      key: "social",
      label: "Social (IG / X / Threads)",
      db: null,
      available: socialLinked > 0,
      count: socialLinked,
      note: "linked in graph; scrapers store per-VM (no shared DB)",
    },
  ];

  return { generatedAt: new Date().toISOString(), verticals, graph };
}

async function main() {
  const args = parseArgs(process.argv);
  const recipients = args.to && args.to.length ? args.to : config.mail.recipients;

  const metrics = await collectMetrics();
  const { subject, html } = buildCombinedReport(metrics);

  if (args.dryRun) {
    console.log(JSON.stringify({ event: "report.dry_run", subject, recipients, metrics }, null, 2));
    console.log("\n----- HTML -----\n" + html);
    await closePool().catch(() => {});
    return;
  }

  const result = await sendGmailEmail(recipients, subject, html);
  await logEmailReport({
    recipients,
    metrics,
    personsTotal: metrics.graph.personsTotal,
    edgesTotal: metrics.graph.edgesTotal,
    ok: result.success,
    error: result.error,
  }).catch((err) => log("report.log_error", { message: err.message }));

  log(result.success ? "report.sent" : "report.failed", {
    recipients,
    messageId: result.messageId || null,
    error: result.error || null,
  });
  await closePool().catch(() => {});
  if (!result.success) process.exit(1);
}

main().catch(async (err) => {
  console.log(JSON.stringify({ event: "report.fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
});
