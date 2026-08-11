#!/usr/bin/env node
/**
 * Fetch the Census ZCTA gazetteer and reduce it to `zip<TAB>lat<TAB>lng`.
 *
 * The published file is a 1 MB zip of a 33,791-row table with seven columns, five of
 * which this service never uses. Reducing it at fetch time keeps the shipped artefact
 * small and means the service loads three columns instead of parsing land-area figures
 * on every boot.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { config, SEC_USER_AGENT } from "./lib/config.mjs";

const GAZETTEER =
  process.env.CENSUS_GAZETTEER_URL ||
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip";

async function main() {
  const dataDir = path.resolve(process.argv[3] || config.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "zcta-"));
  const zip = path.join(work, "gaz.zip");

  console.log(`[centroids] fetching ${GAZETTEER}`);
  const response = await fetch(GAZETTEER, { headers: { "user-agent": SEC_USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));

  execFileSync("unzip", ["-o", "-q", zip, "-d", work]);
  const txt = fs.readdirSync(work).find((name) => name.endsWith(".txt"));
  if (!txt) throw new Error("No .txt inside the gazetteer archive");

  const lines = fs.readFileSync(path.join(work, txt), "utf8").split("\n");
  const header = lines[0].split("\t").map((cell) => cell.trim());
  const zipCol = header.indexOf("GEOID");
  const latCol = header.indexOf("INTPTLAT");
  const lngCol = header.indexOf("INTPTLONG");

  if (zipCol < 0 || latCol < 0 || lngCol < 0) {
    throw new Error(`Unexpected gazetteer columns: ${header.join(",")}`);
  }

  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split("\t");
    if (cells.length <= lngCol) continue;
    const code = cells[zipCol].trim();
    const lat = cells[latCol].trim();
    const lng = cells[lngCol].trim();
    if (!code || !lat || !lng) continue;
    out.push(`${code}\t${lat}\t${lng}`);
  }

  const target = path.join(dataDir, "zcta-centroids.tsv");
  fs.writeFileSync(target, `${out.join("\n")}\n`);
  console.log(`[centroids] wrote ${target} (${out.length} postcodes)`);
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("[centroids] failed:", error.message);
  process.exit(1);
});
