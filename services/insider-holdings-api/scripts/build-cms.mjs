#!/usr/bin/env node
/**
 * Build the CMS Open Payments physician-ownership roster.
 *
 *   node scripts/build-cms.mjs --year 2025
 *
 * One keyless JSON API, paged. The whole 2025 ownership file is ~2,600 rows, so this is
 * the cheapest source in the service — a full year takes under a minute, unlike the SEC
 * ingests which are thousands of paced fetches.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "./lib/config.mjs";
import { buildPhysicians } from "./lib/cms-ownership.mjs";

/** Dataset identifiers from the CMS metastore, by program year. */
const DATASETS = Object.freeze({
  2025: "800aed1b-20ed-4d19-b0c9-dcd10f197ffc",
  2024: "9ac4f7f8-b6e4-4d80-8410-4aba7e71dd02",
  2023: "ac0bc85c-02e3-45d9-89e8-2ff43da85df7",
});

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const log = (...parts) => console.log("[cms]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const year = arg("year", "2025");
  const dataset = DATASETS[year];
  if (!dataset) throw new Error(`No CMS dataset known for ${year}. Have: ${Object.keys(DATASETS).join(", ")}`);

  const dataDir = path.resolve(arg("out", config.dataDir));
  fs.mkdirSync(dataDir, { recursive: true });

  const headers = { "user-agent": config.sec.userAgent, accept: "application/json" };
  const rows = [];
  const pageSize = 500;

  for (let offset = 0; ; offset += pageSize) {
    const url =
      `https://openpaymentsdata.cms.gov/api/1/datastore/query/${dataset}/0` +
      `?limit=${pageSize}&offset=${offset}&results=true&count=true`;

    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from CMS`);

    const body = await response.json();
    const page = body.results || [];
    rows.push(...page);
    log(`${rows.length}/${body.count ?? "?"} rows`);

    if (page.length < pageSize) break;
    await sleep(120);
  }

  const people = buildPhysicians(rows);
  people.sort((a, b) => (b.totalDisclosedInterest || 0) - (a.totalDisclosedInterest || 0));

  const output = {
    meta: {
      builtAt: new Date().toISOString(),
      programYear: Number(year),
      rowsSeen: rows.length,
      people: people.length,
      // The gap between rows and people is family-held interests, which are excluded,
      // plus physicians holding several stakes. Reported so it is not mistaken for loss.
      excludedFamilyHeld: rows.filter(
        (r) => !/physician covered recipient/i.test(String(r.interest_held_by_physician_or_an_immediate_family_member || "")),
      ).length,
      source: "CMS Open Payments — Physician Ownership and Investment Interest (42 U.S.C. §1320a-7h)",
      licence: "https://www.usa.gov/government-works — US Government work, no commercial-use restriction",
      geo: "city and state only — the source's street field is often a solo practitioner's home",
    },
    people,
  };

  const target = path.join(dataDir, "physician-ownership.json");
  fs.writeFileSync(target, JSON.stringify(output));
  log(`wrote ${target}: ${people.length} physicians from ${rows.length} rows`);
}

main().catch((error) => {
  console.error("[cms] failed:", error.message);
  process.exit(1);
});
