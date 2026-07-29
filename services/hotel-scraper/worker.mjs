#!/usr/bin/env node
// The 24/7 crawler. Claims the nearest pending ZIP to Kirkland, enriches it via
// Places, marks it done, repeats — forever. Once every ZIP is done it rolls into
// refresh mode (re-scraping the stalest ZIPs), so the dataset stays fresh. Runs
// under systemd with Restart=always; kill/restart resumes with no lost work.
//
// Usage:
//   node worker.mjs                # run forever (production)
//   node worker.mjs --limit 5      # process 5 ZIPs then exit (local verification)
//   node worker.mjs --once         # process exactly one ZIP then exit

import { config, assertPlacesKey } from "./scripts/lib/config.mjs";
import {
  claimNextZip,
  markZipDone,
  markZipError,
  requeueStaleInProgress,
  ping,
  closePool,
} from "./scripts/lib/db.mjs";
import { processZip } from "./scripts/lib/pipeline.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { limit: Infinity, once: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]) || Infinity;
    else if (argv[i] === "--once") args.once = true;
  }
  if (args.once) args.limit = Math.min(args.limit, 1);
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

  // Fail fast if the enrichment key is missing — the whole loop depends on it.
  assertPlacesKey();

  // Confirm DB reachable before looping (surfaces proxy/creds problems immediately).
  await ping();

  const requeued = await requeueStaleInProgress({ olderThanMinutes: 30 });
  console.log(JSON.stringify({ event: "worker.start", requeued, limit: args.limit === Infinity ? null : args.limit }));

  let processed = 0;
  let idleStreak = 0;

  while (!stopping && processed < args.limit) {
    let zipRow;
    try {
      zipRow = await claimNextZip();
    } catch (err) {
      console.log(JSON.stringify({ event: "worker.claim_error", message: err.message }));
      await sleep(5000);
      continue;
    }

    if (!zipRow) {
      // Nothing pending and nothing stale enough to refresh — idle briefly.
      // Bounded backoff so we don't hammer the DB when fully caught up.
      idleStreak++;
      if (args.limit !== Infinity) break; // in --limit/--once mode, don't wait around
      const wait = Math.min(config.worker.maxBackoffMs, 15_000 * idleStreak);
      console.log(JSON.stringify({ event: "worker.idle", waitMs: wait }));
      await sleep(wait);
      continue;
    }
    idleStreak = 0;

    const t0 = Date.now();
    try {
      const r = await processZip(zipRow);
      await markZipDone(zipRow.zip, { placesCalls: r.placesCalls, hotelsFound: r.hotelsFound });
      processed++;
      console.log(
        JSON.stringify({
          event: "worker.zip_done",
          zip: zipRow.zip,
          state: zipRow.state,
          mode: zipRow._mode,
          distKm: zipRow.dist_km_from_kirkland == null ? null : Math.round(zipRow.dist_km_from_kirkland),
          results: r.results,
          inserted: r.inserted,
          hotelsFound: r.hotelsFound,
          placesCalls: r.placesCalls,
          ms: Date.now() - t0,
        }),
      );
    } catch (err) {
      await markZipError(zipRow.zip, err.message).catch(() => {});
      console.log(JSON.stringify({ event: "worker.zip_error", zip: zipRow.zip, message: err.message }));
    }

    await sleep(config.worker.zipGapMs);
  }

  console.log(JSON.stringify({ event: "worker.stop", processed, stopping }));
  await closePool().catch(() => {});
}

main().catch(async (err) => {
  console.log(JSON.stringify({ event: "worker.fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
});
