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
import { buildReport } from "./lib/report-render.mjs";

function parseArgs(argv) {
  const args = { dryRun: false, to: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--to") args.to = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return args;
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
