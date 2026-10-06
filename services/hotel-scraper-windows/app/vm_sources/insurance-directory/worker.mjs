#!/usr/bin/env node
// The 24/7 collector. Seeds the per-state queue from the configured adapters, marks
// blocked states (with their unblock notes), then claims one working state at a time,
// runs its adapter, upserts producers, and stamps state_progress — forever. Once every
// working state is collected it rolls into refresh mode (re-pulling the stalest state
// past the refresh window), so the directory stays current. Runs under systemd with
// Restart=always; kill/restart resumes with no lost work (state_progress is the ledger).
//
// Usage:
//   node worker.mjs                # run forever (production)
//   node worker.mjs --limit 2      # collect 2 states then exit (local verification)
//   node worker.mjs --once         # collect exactly one state then exit

import { config } from "./scripts/lib/config.mjs";
import {
  seedStateProgress,
  claimNextState,
  markStateDone,
  markStateError,
  markStateBlocked,
  requeueStaleRunning,
  ping,
  closePool,
} from "./scripts/lib/db.mjs";
import { selectedAdapters, getAdapter } from "./scripts/lib/adapters/index.mjs";
import { runStateAdapter } from "./scripts/lib/pipeline.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));

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
      log({ event: "worker.signal", sig });
      stopping = true;
    });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  installSignalHandlers();

  // Confirm DB reachable before looping (surfaces proxy/creds problems immediately).
  await ping();

  const { adapters, missing } = selectedAdapters(config.states);
  if (missing.length) log({ event: "worker.unknown_states", states: missing });

  // Register every configured state and keep its adapter_kind current.
  await seedStateProgress(adapters.map((a) => ({ state: a.code, kind: a.kind })));

  // Mark blocked states once, up front — they are never claimed by the loop (re-running
  // them can't help until their adapter gains a real source), so this keeps /status and
  // the report honest without burning worker cycles.
  const blocked = adapters.filter((a) => a.kind === "blocked");
  for (const a of blocked) await markStateBlocked(a.code, a.note);
  if (blocked.length) log({ event: "worker.blocked_states", states: blocked.map((a) => a.code) });

  const workable = adapters.filter((a) => a.kind !== "blocked").map((a) => a.code);
  const requeued = await requeueStaleRunning();
  log({
    event: "worker.start",
    requeued,
    configured: config.states,
    workable,
    blocked: blocked.map((a) => a.code),
    limit: args.limit === Infinity ? null : args.limit,
  });

  let processed = 0;
  let idleStreak = 0;

  while (!stopping && processed < args.limit) {
    let stateRow;
    try {
      stateRow = await claimNextState({ states: workable });
    } catch (err) {
      log({ event: "worker.claim_error", message: err.message });
      await sleep(5000);
      continue;
    }

    if (!stateRow) {
      // Nothing pending and nothing stale enough to refresh — idle with bounded backoff.
      idleStreak++;
      if (args.limit !== Infinity) break; // in --limit/--once mode, don't wait around
      const wait = Math.min(config.worker.maxBackoffMs, 15_000 * idleStreak);
      log({ event: "worker.idle", waitMs: wait });
      await sleep(wait);
      continue;
    }
    idleStreak = 0;

    const adapter = getAdapter(stateRow.state);
    const t0 = Date.now();
    try {
      if (!adapter) throw new Error(`No adapter registered for ${stateRow.state}`);
      const r = await runStateAdapter(adapter, { log });
      if (r.blocked) {
        await markStateBlocked(stateRow.state, r.note);
      } else {
        await markStateDone(stateRow.state, { producersUpserted: r.upserted });
      }
      processed++;
      log({
        event: "worker.state_done",
        state: stateRow.state,
        kind: r.kind,
        blocked: r.blocked,
        seen: r.seen,
        upserted: r.upserted,
        inserted: r.inserted,
        ms: Date.now() - t0,
      });
    } catch (err) {
      await markStateError(stateRow.state, err.message).catch(() => {});
      log({ event: "worker.state_error", state: stateRow.state, message: err.message });
    }

    await sleep(config.worker.stateGapMs);
  }

  log({ event: "worker.stop", processed, stopping });
  await closePool().catch(() => {});
}

main().catch(async (err) => {
  log({ event: "worker.fatal", message: err.message });
  await closePool().catch(() => {});
  process.exit(1);
});
