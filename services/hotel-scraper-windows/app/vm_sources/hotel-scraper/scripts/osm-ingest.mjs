#!/usr/bin/env node
// CLI: bulk-load OpenStreetMap lodging for every US state (the free coverage layer).
// Usage:
//   node scripts/osm-ingest.mjs                 # all states, Kirkland's (WA) first
//   node scripts/osm-ingest.mjs --only US-WA    # one or more states (repeatable/CSV)
//   node scripts/osm-ingest.mjs --gap-ms 5000   # spacing between Overpass queries

import { ingestAllStates } from "./lib/osm-ingest.mjs";
import { closePool } from "./lib/db.mjs";

function parseArgs(argv) {
  const args = { only: null, gapMs: 3000, startState: "US-WA" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") {
      const val = argv[++i] || "";
      args.only = val.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (a === "--gap-ms") {
      args.gapMs = Number(argv[++i]) || 3000;
    } else if (a === "--start") {
      args.startState = (argv[++i] || "US-WA").toUpperCase();
    }
  }
  return args;
}

const args = parseArgs(process.argv);
try {
  const { totals } = await ingestAllStates(args);
  console.log(JSON.stringify({ event: "osm.cli_done", ...totals }));
  await closePool();
  process.exit(totals.errors && !totals.upserted ? 1 : 0);
} catch (err) {
  console.log(JSON.stringify({ event: "osm.cli_fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
}
