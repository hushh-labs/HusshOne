#!/usr/bin/env node
// The 24/7 photo resolver. Claims batches of hotels that have a place_id and need
// photos — backfilling never-resolved rows first (most-reviewed hotels first),
// then refreshing rows whose image URLs have aged out — resolves the top few
// images per hotel via Google Places, and stores the URLs. Runs under systemd with
// Restart=always; kill/restart resumes cleanly (stuck 'in_progress' rows are
// requeued on start).
//
// Cost note: fetching photo *names* is free (Place Details IDs-Only); each resolved
// image URL costs ~$7/1000 (Place Photo media). Bounded by config.photos.maxPerHotel.
//
// Usage:
//   node photos-worker.mjs                 # run forever (production)
//   node photos-worker.mjs --limit 20      # resolve ~20 hotels then exit (local)
//   node photos-worker.mjs --once          # resolve exactly one batch then exit

import { config, assertPlacesKey } from "./scripts/lib/config.mjs";
import {
  claimPhotoBatch,
  savePhotos,
  markPhotosNone,
  markPhotosError,
  requeueStalePhotos,
  recordPhotoSpend,
  getPhotoSpend,
  ping,
  closePool,
} from "./scripts/lib/db.mjs";
import { resolveHotelPhotos } from "./scripts/lib/photos.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { limit: Infinity, once: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--limit") {
      const v = Number(argv[++i]);
      // A bad --limit must not silently become Infinity and kick off an unbounded
      // paid run — fail loudly instead.
      if (!Number.isFinite(v) || v <= 0) {
        console.error("--limit must be a positive number");
        process.exit(2);
      }
      args.limit = Math.floor(v);
    } else if (argv[i] === "--once") args.once = true;
  }
  return args;
}

let stopping = false;
function installSignalHandlers() {
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      console.log(JSON.stringify({ event: "photos.signal", sig }));
      stopping = true;
    });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  installSignalHandlers();

  if (!config.photos.enabled) {
    console.log(JSON.stringify({ event: "photos.disabled" }));
    // Idle quietly under systemd rather than crash-looping via Restart=always.
    while (!stopping && args.limit === Infinity) await sleep(60_000);
    await closePool().catch(() => {});
    return;
  }

  // The resolver depends entirely on the Places key + a reachable DB.
  assertPlacesKey();
  await ping();

  const requeued = await requeueStalePhotos({});
  console.log(
    JSON.stringify({
      event: "photos.start",
      requeued,
      limit: args.limit === Infinity ? null : args.limit,
      maxPerHotel: config.photos.maxPerHotel,
      maxWidthPx: config.photos.maxWidthPx,
    }),
  );

  let processed = 0;
  let idleStreak = 0;
  let lastRequeue = Date.now();
  const forever = args.limit === Infinity;

  while (!stopping && processed < args.limit) {
    // Budget ceiling: once today's paid media spend hits dailyBudgetUsd, stop
    // billing. Locally that ends the run; in production we pause (not exit — the
    // ledger resets at UTC midnight) so Restart=always doesn't crash-loop.
    if (config.photos.dailyBudgetUsd > 0) {
      let spend;
      try {
        spend = await getPhotoSpend();
      } catch (err) {
        console.log(JSON.stringify({ event: "photos.spend_error", message: err.message }));
        await sleep(5000);
        continue;
      }
      if (spend.todayUsd >= config.photos.dailyBudgetUsd) {
        if (!forever) {
          console.log(
            JSON.stringify({
              event: "photos.budget_reached",
              todayUsd: spend.todayUsd,
              dailyBudgetUsd: config.photos.dailyBudgetUsd,
            }),
          );
          break;
        }
        console.log(
          JSON.stringify({
            event: "photos.budget_paused",
            todayUsd: spend.todayUsd,
            dailyBudgetUsd: config.photos.dailyBudgetUsd,
          }),
        );
        await sleep(300_000); // re-check in ~5 min; UTC-midnight reset clears it
        continue;
      }
    }

    // Periodically recover crashed/stuck claims so a killed run can't strand rows.
    if (forever && Date.now() - lastRequeue > 600_000) {
      const n = await requeueStalePhotos({}).catch(() => 0);
      lastRequeue = Date.now();
      if (n) console.log(JSON.stringify({ event: "photos.requeued", count: n }));
    }

    const remaining = args.limit === Infinity ? config.photos.batchSize : args.limit - processed;
    const batchSize = Math.min(config.photos.batchSize, Math.max(1, remaining));

    let batch;
    try {
      batch = await claimPhotoBatch({ batchSize });
    } catch (err) {
      console.log(JSON.stringify({ event: "photos.claim_error", message: err.message }));
      await sleep(5000);
      continue;
    }

    if (!batch.rows.length) {
      idleStreak++;
      if (args.limit !== Infinity || args.once) break; // don't wait around locally
      const wait = Math.min(config.worker.maxBackoffMs, 15_000 * idleStreak);
      console.log(JSON.stringify({ event: "photos.idle", waitMs: wait }));
      await sleep(wait);
      continue;
    }
    idleStreak = 0;

    for (const hotel of batch.rows) {
      if (stopping || processed >= args.limit) break;
      const t0 = Date.now();
      try {
        const r = await resolveHotelPhotos(hotel);
        // Record billed media fetches before anything else so a later crash can't
        // lose spend that Google already charged us for.
        if (r.billedMedia) await recordPhotoSpend(r.billedMedia).catch(() => {});
        if (r.status === "none") {
          await markPhotosNone(hotel.id);
        } else {
          await savePhotos(hotel.id, { refs: r.refs, photos: r.photos });
        }
        processed++;
        console.log(
          JSON.stringify({
            event: "photos.hotel_done",
            id: hotel.id,
            mode: batch.mode,
            status: r.status,
            count: r.photos.length,
            billed: r.billedMedia,
            ms: Date.now() - t0,
          }),
        );
      } catch (err) {
        // Even a failed hotel may have billed some media (e.g. 200-but-empty
        // responses on the softAllFailed path) — record what Google charged.
        if (err.billedMedia) await recordPhotoSpend(err.billedMedia).catch(() => {});
        await markPhotosError(hotel.id, err.message).catch(() => {});
        console.log(
          JSON.stringify({ event: "photos.hotel_error", id: hotel.id, message: err.message }),
        );
      }
      await sleep(config.photos.gapMs);
    }

    if (args.once) break;
  }

  console.log(JSON.stringify({ event: "photos.stop", processed, stopping }));
  await closePool().catch(() => {});
}

main().catch(async (err) => {
  console.log(JSON.stringify({ event: "photos.fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
});
