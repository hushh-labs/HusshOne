#!/usr/bin/env node
// The 24/7 ingest worker. On start it ensures the latest monthly NPPES full file is
// ingested (streaming, resumable, idempotent), then loops forever: sleep, re-check
// the NPPES index for a newer weekly/monthly file, ingest any deltas, repeat. Runs
// under systemd with Restart=always; kill/restart resumes with no lost work because
// every file is recorded in ingest_runs and upserts are ON CONFLICT (npi).
//
// Usage:
//   node worker.mjs                # run forever (production)
//   node worker.mjs --once         # run exactly one refresh pass then exit
//   node worker.mjs --csv PATH     # ingest a local unzipped pfile CSV then continue
//   node worker.mjs --no-loop      # do the initial ingest/refresh, then exit

import { config } from "./scripts/lib/config.mjs";
import { ping, getProgress, closePool } from "./scripts/lib/db.mjs";
import { ingestFile, runRefreshCycle } from "./scripts/lib/pipeline.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { once: false, loop: true, csv: config.nppes.csvPath || null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--once") args.once = true;
    else if (argv[i] === "--no-loop") args.loop = false;
    else if (argv[i] === "--csv") args.csv = argv[++i] || null;
  }
  return args;
}

let stopping = false;
function installSignalHandlers() {
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      console.log(JSON.stringify({ event: "worker.signal", sig }));
      stopping = true;
    });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  installSignalHandlers();

  // Confirm DB reachable before ingesting (surfaces proxy/creds problems immediately).
  await ping();
  console.log(JSON.stringify({ event: "worker.start", once: args.once, loop: args.loop, csv: args.csv || null }));

  // Initial ingest. If a local CSV path is configured/passed, ingest that first
  // (VM init unzips the monthly file once; local dev points at a sample). Otherwise
  // discover + download the newest monthly full file.
  try {
    if (args.csv) {
      await ingestFile({ csvPath: args.csv, kind: "bulk" });
    } else {
      await runRefreshCycle();
    }
  } catch (err) {
    console.log(JSON.stringify({ event: "worker.initial_error", message: err.message }));
    // Fall through into the loop (or exit) — the next cycle retries with backoff.
  }

  if (args.once || !args.loop) {
    const progress = await getProgress().catch(() => null);
    console.log(JSON.stringify({ event: "worker.stop", once: true, providersTotal: progress?.providersTotal ?? null }));
    await closePool().catch(() => {});
    return;
  }

  // Steady state: periodically re-check the index for newer weekly/monthly files.
  let backoff = 0;
  while (!stopping) {
    const waitMs = backoff || config.worker.refreshCheckMs;
    console.log(JSON.stringify({ event: "worker.sleep", waitMs }));
    // Sleep in short slices so SIGTERM is honored promptly.
    const until = Date.now() + waitMs;
    while (!stopping && Date.now() < until) await sleep(Math.min(5000, until - Date.now()));
    if (stopping) break;

    try {
      const result = await runRefreshCycle();
      const did = result.ingested.filter((r) => r && !r.skipped);
      console.log(JSON.stringify({ event: "worker.refresh_done", ingested: did.length }));
      backoff = 0; // reset on success
    } catch (err) {
      backoff = Math.min(config.worker.maxBackoffMs, backoff ? backoff * 2 : 60_000);
      console.log(JSON.stringify({ event: "worker.refresh_error", message: err.message, nextBackoffMs: backoff }));
    }
  }

  console.log(JSON.stringify({ event: "worker.stop", stopping }));
  await closePool().catch(() => {});
}

main().catch(async (err) => {
  console.log(JSON.stringify({ event: "worker.fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
});
