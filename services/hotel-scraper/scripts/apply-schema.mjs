#!/usr/bin/env node
// Apply schema.sql to the database (idempotent — every statement is IF NOT EXISTS).
// Run once on first boot and safe to re-run on every deploy. Uses the same pg
// creds as the app, so no psql dependency on the VM.
//
// NOTE: `CREATE EXTENSION postgis` requires a role allowed to create extensions
// (on Cloud SQL, the cloudsqlsuperuser). If the app role can't, pre-create the
// extension once as an admin, then this script's IF NOT EXISTS is a no-op.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, closePool } from "./lib/db.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(HERE, "../schema.sql");

async function main() {
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
