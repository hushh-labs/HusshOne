#!/usr/bin/env node
// Apply schema.sql to the graph's `social` database (idempotent — every statement
// is IF NOT EXISTS). Run once on first boot and safe to re-run on every deploy.
// Uses the same pg creds as the app, so no psql dependency on the VM.
//
// PostGIS is OPTIONAL for this service (the graph reuses the source directories'
// already-geocoded zip/state), so we attempt `CREATE EXTENSION postgis` BEST-EFFORT
// and continue if the role can't create it — nothing in schema.sql depends on it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, closePool } from "./lib/db.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(HERE, "../schema.sql");

async function main() {
  // Best-effort PostGIS (future co-location work); never fatal.
  try {
    await query("CREATE EXTENSION IF NOT EXISTS postgis");
    console.log(JSON.stringify({ event: "apply_schema.postgis_ok" }));
  } catch (err) {
    console.log(JSON.stringify({ event: "apply_schema.postgis_skipped", message: err.message }));
  }

  const sql = fs.readFileSync(SCHEMA_FILE, "utf8");
  await query(sql); // node-postgres runs multi-statement simple queries in one shot
  console.log(JSON.stringify({ event: "apply_schema.done", file: SCHEMA_FILE }));
  await closePool().catch(() => {});
}

main().catch(async (err) => {
  console.log(JSON.stringify({ event: "apply_schema.fatal", message: err.message }));
  await closePool().catch(() => {});
  process.exit(1);
});
