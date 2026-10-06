#!/usr/bin/env node
// CLI: manually drive the NPPES bulk ingest (the worker does this automatically).
// Usage:
//   node scripts/ingest.mjs                    # one refresh pass: discover + ingest deltas
//   node scripts/ingest.mjs --discover         # just print the newest monthly/weekly, no ingest
//   node scripts/ingest.mjs --csv PATH         # stream-ingest a local unzipped npidata pfile
//   node scripts/ingest.mjs --url URL --name F # download+unzip+ingest a specific file
//   NPPES_MAX_ROWS=50000 node scripts/ingest.mjs --csv PATH   # cap rows (smoke test)

import { closePool } from "./lib/db.mjs";
import { discoverLatest, ingestFile, runRefreshCycle } from "./lib/pipeline.mjs";

function parseArgs(argv) {
  const args = { discover: false, csv: null, url: null, name: null, kind: "bulk" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--discover") args.discover = true;
    else if (a === "--csv") args.csv = argv[++i] || null;
    else if (a === "--url") args.url = argv[++i] || null;
    else if (a === "--name") args.name = argv[++i] || null;
    else if (a === "--kind") args.kind = argv[++i] || "bulk";
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.discover) {
    const found = await discoverLatest();
    console.log(JSON.stringify({ event: "ingest.discover", ...found }, null, 2));
    return;
  }

  if (args.csv) {
    const r = await ingestFile({ csvPath: args.csv, kind: args.kind });
    console.log(JSON.stringify({ event: "ingest.cli_done", ...r }));
    return;
  }

  if (args.url) {
    const r = await ingestFile({ url: args.url, filename: args.name, kind: args.kind });
    console.log(JSON.stringify({ event: "ingest.cli_done", ...r }));
    return;
  }

  const result = await runRefreshCycle();
  console.log(
    JSON.stringify({
      event: "ingest.cli_done",
      monthly: result.monthly?.filename || null,
      weekly: result.weekly?.filename || null,
      ingested: result.ingested,
    }),
  );
}

main()
  .then(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.log(JSON.stringify({ event: "ingest.cli_fatal", message: err.message }));
    await closePool().catch(() => {});
    process.exit(1);
  });
