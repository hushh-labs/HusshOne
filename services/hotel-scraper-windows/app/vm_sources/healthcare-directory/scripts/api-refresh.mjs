#!/usr/bin/env node
// CLI: targeted refresh via the NPI Registry API (the SECONDARY source). The API
// caps at 1200 results per query, so it CANNOT enumerate the US — use it to refresh
// a specific state/ZIP/taxonomy slice between monthly bulk drops. Results upsert onto
// the same providers rows (sources gains 'npi_api').
//
// Usage:
//   node scripts/api-refresh.mjs --state WA
//   node scripts/api-refresh.mjs --zip 98033
//   node scripts/api-refresh.mjs --state WA --taxonomy "Family Medicine"

import { closePool, upsertProvidersBatch, startIngestRun, finishIngestRun } from "./lib/db.mjs";
import { searchProviders, mapApiResultToProvider } from "./lib/npi-api.mjs";

function parseArgs(argv) {
  const args = { state: null, zip: null, taxonomy: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--state") args.state = argv[++i] || null;
    else if (a === "--zip") args.zip = argv[++i] || null;
    else if (a === "--taxonomy") args.taxonomy = argv[++i] || null;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.state && !args.zip) {
    console.log(JSON.stringify({ event: "api_refresh.usage", message: "Provide --state XX and/or --zip NNNNN" }));
    process.exit(2);
  }

  const label = `npi_api:${args.state || ""}:${args.zip || ""}:${args.taxonomy || ""}`;
  const runId = await startIngestRun({ kind: "api", sourceFile: label });
  try {
    const { results, calls, capped } = await searchProviders({
      state: args.state,
      postalCode: args.zip,
      taxonomy: args.taxonomy,
    });
    const records = results.map((r) => mapApiResultToProvider(r)).filter(Boolean);
    const { upserted } = records.length ? await upsertProvidersBatch(records) : { upserted: 0 };
    await finishIngestRun(runId, { rowsSeen: results.length, rowsUpserted: upserted, ok: true });
    console.log(
      JSON.stringify({ event: "api_refresh.done", slice: label, results: results.length, upserted, calls, capped }),
    );
    if (capped) {
      console.log(JSON.stringify({ event: "api_refresh.capped", message: "Slice exceeds the 1200-result API ceiling; narrow it (add --zip / --taxonomy)." }));
    }
  } catch (err) {
    await finishIngestRun(runId, { ok: false, error: err.message }).catch(() => {});
    throw err;
  }
}

main()
  .then(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.log(JSON.stringify({ event: "api_refresh.fatal", message: err.message }));
    await closePool().catch(() => {});
    process.exit(1);
  });
