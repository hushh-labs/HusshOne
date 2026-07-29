#!/usr/bin/env node
// Progress report: read the live counters from Postgres, render an HTML summary
// (totals + a per-state breakdown that clearly flags blocked states and why),
// email it to the ops recipients via the Gmail SMTP mailer, and audit the send to
// email_reports. Run on a systemd timer (OnCalendar=daily).
//
// Usage:
//   node scripts/report.mjs              # build + send + log
//   node scripts/report.mjs --dry-run    # build + print to stdout, no send, no log
//   node scripts/report.mjs --to a@b.com # override recipients (comma-separated)

import { pathToFileURL } from "node:url";
import { config } from "./lib/config.mjs";
import { sendGmailEmail } from "./lib/mailer.mjs";

// db.mjs (and its `pg` dependency) is imported lazily inside main() so that unit tests
// can import the pure buildReport() renderer without a live database or the pg module.

function parseArgs(argv) {
  const args = { dryRun: false, to: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--to") args.to = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const esc = (s) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const STATUS_COLOR = {
  done: "#188038",
  running: "#1a73e8",
  pending: "#9aa0a6",
  blocked: "#b06000",
  error: "#c5221f",
};

export function buildReport(progress) {
  const subject =
    `Hushh Insurance Directory — ${fmt(progress.producersTotal)} producers · ` +
    `${fmt(progress.statesActive)}/${fmt(progress.statesConfigured)} states active`;

  const summary = [
    ["Producers collected", fmt(progress.producersTotal)],
    ["&nbsp;&nbsp;• active", fmt(progress.producersActive)],
    ["&nbsp;&nbsp;• inactive", fmt(progress.producersInactive)],
    ["&nbsp;&nbsp;• geo-tagged by ZIP", fmt(progress.producersGeocoded)],
    ["ZIPs covered", fmt(progress.zipsCovered)],
    ["States configured", fmt(progress.statesConfigured)],
    ["&nbsp;&nbsp;• active (open source)", fmt(progress.statesActive)],
    ["&nbsp;&nbsp;• blocked (no free source)", fmt(progress.statesBlocked)],
    ["&nbsp;&nbsp;• with data", fmt(progress.statesWithData)],
  ];
  const summaryTrs = summary
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#555;white-space:nowrap">${k}</td>` +
        `<td style="padding:6px 0;font-weight:600;color:#111">${v}</td></tr>`,
    )
    .join("");

  const stateTrs = (progress.states || [])
    .map((s) => {
      const color = STATUS_COLOR[s.status] || "#555";
      const detail = s.status === "blocked" ? esc(s.note || "") : s.lastError ? esc(s.lastError) : "";
      return (
        `<tr>` +
        `<td style="padding:6px 14px 6px 0;font-weight:600;color:#111">${esc(s.state)}</td>` +
        `<td style="padding:6px 14px 6px 0;color:#555">${esc(s.kind || "—")}</td>` +
        `<td style="padding:6px 14px 6px 0;color:${color};font-weight:600">${esc(s.status)}</td>` +
        `<td style="padding:6px 14px 6px 0;text-align:right;color:#111">${fmt(s.producers)}</td>` +
        `<td style="padding:6px 0;color:#777;font-size:12px">${detail}</td>` +
        `</tr>`
      );
    })
    .join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:640px;margin:0 auto;padding:28px 22px">
      <div style="background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:26px 26px 20px">
        <div style="font-size:18px;font-weight:700;color:#111">US Insurance Producer Directory — progress</div>
        <div style="font-size:13px;color:#777;margin-top:2px">Collecting licensed insurance producers/agents from per-state Departments of Insurance, 24/7. Only states with a free, open bulk source are collected; the rest are flagged blocked with the path to unblock them.</div>
        <table style="border-collapse:collapse;margin-top:18px;font-size:14px;width:100%">${summaryTrs}</table>
        <div style="font-size:13px;font-weight:700;color:#111;margin-top:22px;margin-bottom:6px">Per-state</div>
        <table style="border-collapse:collapse;font-size:13px;width:100%">
          <tr style="color:#9aa0a6;text-align:left">
            <th style="padding:0 14px 4px 0;font-weight:600">State</th>
            <th style="padding:0 14px 4px 0;font-weight:600">Source</th>
            <th style="padding:0 14px 4px 0;font-weight:600">Status</th>
            <th style="padding:0 14px 4px 0;font-weight:600;text-align:right">Producers</th>
            <th style="padding:0 0 4px 0;font-weight:600">Notes</th>
          </tr>
          ${stateTrs}
        </table>
      </div>
      <div style="font-size:11px;color:#9aa0a6;text-align:center;margin-top:14px">
        Hushh Insurance Directory · per-state DOI open data · automated report
      </div>
    </div></body></html>`;
  return { subject, html };
}

async function main() {
  const { getProgress, logEmailReport, closePool } = await import("./lib/db.mjs");
  const args = parseArgs(process.argv);
  const recipients = args.to && args.to.length ? args.to : config.mail.recipients;

  let progress;
  try {
    progress = await getProgress();
  } catch (err) {
    console.log(JSON.stringify({ event: "report.progress_error", message: err.message }));
    await closePool().catch(() => {});
    process.exit(1);
  }

  const { subject, html } = buildReport(progress);

  if (args.dryRun) {
    console.log(JSON.stringify({ event: "report.dry_run", subject, recipients, progress }, null, 2));
    console.log("\n----- HTML -----\n" + html);
    await closePool().catch(() => {});
    return;
  }

  const result = await sendGmailEmail(recipients, subject, html);
  await logEmailReport({ recipients, progress, ok: result.success, error: result.error });
  console.log(
    JSON.stringify({
      event: result.success ? "report.sent" : "report.failed",
      recipients,
      messageId: result.messageId || null,
      error: result.error || null,
      progress,
    }),
  );
  await closePool().catch(() => {});
  if (!result.success) process.exit(1);
}

// Only run when invoked directly (node scripts/report.mjs), not when imported by a test.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(async (err) => {
    console.log(JSON.stringify({ event: "report.fatal", message: err.message }));
    await import("./lib/db.mjs").then((m) => m.closePool()).catch(() => {});
    process.exit(1);
  });
}
