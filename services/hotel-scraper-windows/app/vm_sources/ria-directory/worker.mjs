#!/usr/bin/env node
// The 24/7 RIA ingest loop. On start it runs an ingest cycle: if `firms` is empty or a
// newer SEC Form ADV compilation is available, it downloads + stream-parses the latest
// firm + individual feeds, geo-tags firms by their ZIP, and upserts. Then it sleeps and
// re-checks periodically (roughly monthly refresh cadence). Runs under systemd with
// Restart=always; kill/restart resumes cleanly (upserts are idempotent, ingest_runs is
// the freshness ledger).
//
// Usage:
//   node worker.mjs                                  # run forever (production)
//   node worker.mjs --once                           # run one ingest cycle then exit
//   node worker.mjs --once --force                   # force-ingest latest even if current
//   node worker.mjs --firms-file inputs/firms.csv    # ingest an explicit local CSV
//   node worker.mjs --individuals-file inputs/ia.csv # (e.g. a deploy-time unzipped file)

import { config } from "./scripts/lib/config.mjs";
import { ping, closePool } from "./scripts/lib/db.mjs";
import { runIngestCycle } from "./scripts/lib/pipeline.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { once: false, force: false, firmsFile: null, individualsFile: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--once") args.once = true;
    else if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--firms-file") args.firmsFile = argv[++i];
    else if (argv[i] === "--individuals-file") args.individualsFile = argv[++i];
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

  // Confirm DB reachable before looping (surfaces proxy/creds problems immediately).
  await ping();
  console.log(
    JSON.stringify({
      event: "worker.start",
      once: args.once,
      force: args.force,
      firmsFile: args.firmsFile,
      individualsFile: args.individualsFile,
    }),
  );

  let errorStreak = 0;

  while (!stopping) {
    const t0 = Date.now();
    try {
      const outcome = await runIngestCycle({
        force: args.force,
        firmsFile: args.firmsFile,
        individualsFile: args.individualsFile,
      });
      errorStreak = 0;
      console.log(
        JSON.stringify({ event: "worker.cycle_done", via: outcome.via, results: outcome.results, ms: Date.now() - t0 }),
      );
    } catch (err) {
      errorStreak++;
      console.log(JSON.stringify({ event: "worker.cycle_error", message: err.message, errorStreak }));
    }

    if (args.once) break;

    // Bounded backoff on repeated failure; otherwise the steady-state check interval.
    const wait =
      errorStreak > 0
        ? Math.min(config.worker.maxBackoffMs, 60_000 * 2 ** (errorStreak - 1))
        : config.worker.checkIntervalMs;
    console.log(JSON.stringify({ event: "worker.sleep", waitMs: wait }));

    // Sleep in short slices so SIGTERM is honored promptly.
    const until = Date.now() + wait;
    while (!stopping && Date.now() < until) {
      await sleep(Math.min(2000, until - Date.now()));
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
