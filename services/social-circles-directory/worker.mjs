#!/usr/bin/env node
// The 24/7 graph builder. Runs a full rebuild pass (link people/orgs across the
// four directory DBs + social scrapers, write the graph to `social`), sleeps, then
// rebuilds — forever. Every pass is idempotent (all writes are upserts), so a
// kill/restart resumes with no lost or duplicated work, and a pass over empty or
// unreachable source DBs completes cleanly instead of crashing.
//
// Usage:
//   node worker.mjs                # run forever (production)
//   node worker.mjs --once         # run exactly one rebuild pass, then exit
//   node worker.mjs --interval 60  # override sleep between passes (seconds)

import { config } from "./scripts/lib/config.mjs";
import { runBuildPass } from "./scripts/lib/build.mjs";
import { ping, closePool } from "./scripts/lib/db.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { once: false, intervalMs: config.worker.rebuildIntervalMs };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--once") args.once = true;
    else if (argv[i] === "--interval") args.intervalMs = (Number(argv[++i]) || 0) * 1000 || args.intervalMs;
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

  // Confirm the graph DB is reachable before looping (surfaces proxy/creds issues
  // immediately). Source DBs are checked per-pass and tolerated if missing.
  await ping();
  console.log(
    JSON.stringify({ event: "worker.start", once: args.once, intervalMs: args.once ? null : args.intervalMs }),
  );

  let failStreak = 0;

  while (!stopping) {
    try {
      await runBuildPass();
      failStreak = 0;
    } catch (err) {
      failStreak++;
      console.log(JSON.stringify({ event: "worker.pass_error", failStreak, message: err.message }));
    }

    if (args.once || stopping) break;

    // On repeated failures back off (bounded) instead of hammering; otherwise wait
    // the normal rebuild interval before the next full pass.
    const wait =
      failStreak > 0
        ? Math.min(config.worker.maxBackoffMs, 15_000 * failStreak)
        : args.intervalMs;
    // Sleep in short slices so SIGTERM stops us promptly mid-wait.
    const until = Date.now() + wait;
    console.log(JSON.stringify({ event: "worker.sleep", waitMs: wait }));
    while (!stopping && Date.now() < until) await sleep(Math.min(1000, until - Date.now()));
  }

  console.log(JSON.stringify({ event: "worker.stop", stopping }));
  await closePool().catch(() => {});
}

main().catch(async (err) => {
  console.log(JSON.stringify({ event: "worker.fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
});
