#!/usr/bin/env node
// Daily progress report: read the live counters from Postgres, render an HTML
// summary, email it to the ops recipients via the Gmail SMTP mailer, and
// audit the send to email_reports. Run on a systemd timer (OnCalendar=daily).
//
// Usage:
//   node scripts/report.mjs              # build + send + log
//   node scripts/report.mjs --dry-run    # build + print to stdout, no send, no log
//   node scripts/report.mjs --to a@b.com # override recipients (comma-separated)

import { config } from "./lib/config.mjs";
import { getProgress, logEmailReport, closePool } from "./lib/db.mjs";
import { sendGmailEmail } from "./lib/mailer.mjs";
import { KIRKLAND } from "./lib/config.mjs";

function parseArgs(argv) {
  const args = { dryRun: false, to: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--to") args.to = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

const fmt = (n) => Number(n || 0).toLocaleString("en-US");

export function buildReport(progress) {
  const subject = `Hushh Hotel Crawler — ${progress.pctDone}% of US ZIPs (${fmt(progress.zipsDone)}/${fmt(progress.zipsTotal)})`;
  const rows = [
    ["ZIPs done", `${fmt(progress.zipsDone)} (${progress.pctDone}%)`],
    ["ZIPs left", fmt(progress.zipsLeft)],
    ["&nbsp;&nbsp;• pending", fmt(progress.zipsPending)],
    ["&nbsp;&nbsp;• in progress", fmt(progress.zipsInProgress)],
    ["&nbsp;&nbsp;• errored", fmt(progress.zipsError)],
    ["States touched", `${fmt(progress.statesTouched)} / 56`],
    ["Hotels collected", fmt(progress.hotelsTotal)],
    ["&nbsp;&nbsp;• from OpenStreetMap", fmt(progress.hotelsOsm)],
    ["&nbsp;&nbsp;• enriched by Places", fmt(progress.hotelsPlaces)],
    ["Places API calls", fmt(progress.placesCallsTotal)],
    ["Est. Places spend", `$${fmt(progress.estCostUsd)}`],
    ["Photos resolved", `${fmt(progress.photos.withUrls)} hotels (${progress.photos.pctDone}% of eligible)`],
    ["&nbsp;&nbsp;• image URLs stored", fmt(progress.photos.urlsTotal)],
    ["&nbsp;&nbsp;• awaiting / retrying", `${fmt(progress.photos.pending)} / ${fmt(progress.photos.error)}`],
    ["Photo media fetches", `${fmt(progress.photos.mediaFetchesTotal)} (${fmt(progress.photos.mediaFetchesToday)} today)`],
    ["Photo media spend", `$${fmt(progress.photos.mediaSpendUsd)} ($${fmt(progress.photos.mediaSpendTodayUsd)} today)`],
    ["Total est. spend", `$${fmt(Math.round((progress.estCostUsd + progress.photos.mediaSpendUsd) * 100) / 100)}`],
    ["Crawl frontier", progress.frontierKm == null ? "—" : `${fmt(progress.frontierKm)} km from Kirkland`],
  ];
  const trs = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#555;white-space:nowrap">${k}</td>` +
        `<td style="padding:6px 0;font-weight:600;color:#111">${v}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:28px 22px">
      <div style="background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:26px 26px 20px">
        <div style="font-size:18px;font-weight:700;color:#111">US Hotel Crawler — daily progress</div>
        <div style="font-size:13px;color:#777;margin-top:2px">Crawling outward from Kirkland, WA (${KIRKLAND.zip}) across all ~42k US ZIP codes, 24/7.</div>
        <table style="border-collapse:collapse;margin-top:18px;font-size:14px;width:100%">${trs}</table>
      </div>
      <div style="font-size:11px;color:#9aa0a6;text-align:center;margin-top:14px">
        Hushh Hotel Crawler · OpenStreetMap (ODbL) + Google Places · automated report
      </div>
    </div></body></html>`;
  return { subject, html };
}

async function main() {
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

main().catch(async (err) => {
  console.log(JSON.stringify({ event: "report.fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
});
