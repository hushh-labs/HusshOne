#!/usr/bin/env node
// Load the ZIP universe into the `zips` table from the GeoNames US postal export
// (inputs/US.txt, tab-separated). Idempotent: re-running refreshes geo fields via
// ON CONFLICT and preserves each ZIP's crawl status/counters, so it's safe to run
// on every deploy. Streams the file line-by-line (~42k rows) and inserts in
// batches to keep memory flat and round-trips low.
//
// GeoNames ships the file zipped (US.zip); the init step unzips it to US.txt
// before this runs (Node has no built-in zip-container extraction).
//
// Usage:
//   node scripts/load-zips.mjs                       # load inputs/US.txt
//   node scripts/load-zips.mjs --file /path/US.txt   # explicit path
//   node scripts/load-zips.mjs --limit 500           # load only first 500 (local test)
//   node scripts/load-zips.mjs --batch 2000          # rows per INSERT (default 1000)

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseGeoNamesLine } from "./lib/zip.mjs";
import { insertZipsBatch, closePool } from "./lib/db.mjs";
import { KIRKLAND } from "./lib/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(HERE, "../inputs/US.txt");

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, limit: Infinity, batch: 1000 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]) || Infinity;
    else if (argv[i] === "--batch") args.batch = Math.max(1, Number(argv[++i]) || 1000);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(args.file)) {
    console.log(
      JSON.stringify({
        event: "load_zips.missing_file",
        file: args.file,
        hint: "Download https://download.geonames.org/export/zip/US.zip and unzip US.txt into inputs/ (init step does this).",
      }),
    );
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(args.file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let read = 0;
  let parsed = 0;
  let skipped = 0;
  let inserted = 0;
  let nearestKm = Infinity;
  let nearestZip = null;
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    inserted += await insertZipsBatch(batch);
    batch = [];
  };

  for await (const line of rl) {
    if (parsed >= args.limit) break;
    read++;
    const row = parseGeoNamesLine(line);
    if (!row) {
      skipped++;
      continue;
    }
    parsed++;
    if (row.distKm < nearestKm) {
      nearestKm = row.distKm;
      nearestZip = row.zip;
    }
    batch.push(row);
    if (batch.length >= args.batch) {
      await flush();
      if (parsed % 10000 === 0) {
        console.log(JSON.stringify({ event: "load_zips.progress", parsed, inserted }));
      }
    }
  }
  await flush();

  console.log(
    JSON.stringify({
      event: "load_zips.done",
      file: args.file,
      linesRead: read,
      zipsParsed: parsed,
      linesSkipped: skipped,
      newlyInserted: inserted,
      nearestToKirkland: { zip: nearestZip, km: nearestKm === Infinity ? null : Math.round(nearestKm * 100) / 100 },
      kirklandZip: KIRKLAND.zip,
    }),
  );

  await closePool().catch(() => {});
}

main().catch(async (err) => {
  console.log(JSON.stringify({ event: "load_zips.fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
});
