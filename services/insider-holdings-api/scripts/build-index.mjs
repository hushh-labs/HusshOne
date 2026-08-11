#!/usr/bin/env node
/**
 * Build the served index from free public sources.
 *
 *   node scripts/build-index.mjs --quarter 2026q2
 *
 * Three inputs, all free, none scraped:
 *   1. The SEC's quarterly Form 3/4/5 dataset zip  (positions, prices, names, roles)
 *   2. EDGAR's submissions API                      (issuer business addresses)
 *   3. The Census ZCTA gazetteer, bundled           (postcode -> coordinates)
 *
 * Issuer lookups dominate the runtime: one HTTP call per distinct issuer, throttled to
 * stay inside the SEC's published rate. A quarter has roughly 5,000 distinct issuers,
 * so a cold build takes on the order of twenty minutes. It is meant to run on a
 * schedule, not in a request.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { config } from "./lib/config.mjs";
import { buildPositions, parseTsv, valuePosition } from "./lib/dataset.mjs";
import { fetchIssuer } from "./lib/issuer.mjs";
import { loadCentroids } from "./lib/geo.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const log = (...parts) => console.log(`[build-index]`, ...parts);

async function download(url, destination) {
  const response = await fetch(url, { headers: { "user-agent": config.sec.userAgent } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function fetchQuarter(quarter, workDir) {
  const zip = path.join(workDir, `${quarter}.zip`);

  // The SEC reorganised these paths mid-2026; newer quarters live under the new prefix.
  // Try both rather than pinning to whichever happened to be current at write time.
  const candidates = [
    `${config.sec.datasetBaseAlt}/${quarter}_form345.zip`,
    `${config.sec.datasetBase}/${quarter}_form345.zip`,
  ];

  let lastError = null;
  for (const url of candidates) {
    try {
      log(`fetching ${url}`);
      await download(url, zip);
      const extractTo = path.join(workDir, quarter);
      fs.mkdirSync(extractTo, { recursive: true });
      execFileSync("unzip", ["-o", "-q", zip, "-d", extractTo]);
      return extractTo;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not fetch ${quarter}: ${lastError?.message}`);
}

const readTable = (dir, name) => [...parseTsv(fs.readFileSync(path.join(dir, `${name}.tsv`), "utf8"))];

async function main() {
  const quarter = arg("quarter", "2026q2");
  const dataDir = path.resolve(arg("out", config.dataDir));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "insider-"));

  fs.mkdirSync(dataDir, { recursive: true });

  const extracted = await fetchQuarter(quarter, workDir);
  log("parsing tables");

  const positions = buildPositions({
    submissions: readTable(extracted, "SUBMISSION"),
    owners: readTable(extracted, "REPORTINGOWNER"),
    transactions: readTable(extracted, "NONDERIV_TRANS"),
    holdings: readTable(extracted, "NONDERIV_HOLDING"),
  });
  log(`positions: ${positions.size}`);

  // Group by person.
  const people = new Map();
  const issuerCiks = new Set();

  for (const position of positions.values()) {
    issuerCiks.add(position.issuerCik);
    const value = valuePosition(position);

    if (!people.has(position.personCik)) {
      people.set(position.personCik, {
        cik: position.personCik,
        name: position.personName,
        roles: new Set(),
        titles: new Set(),
        positions: [],
        disclosedValue: 0,
        positionsValued: 0,
      });
    }

    const person = people.get(position.personCik);
    for (const role of position.relationship.split(",")) person.roles.add(role.trim());
    if (position.title) person.titles.add(position.title);

    person.positions.push({
      issuerCik: position.issuerCik,
      issuerName: position.issuerName,
      ticker: position.ticker,
      security: position.security,
      shares: position.shares,
      pricePerShare: position.pricePerShare,
      value,
      asOf: position.asOf,
      formType: position.formType,
      title: position.title,
    });

    if (value != null) {
      person.disclosedValue += value;
      person.positionsValued += 1;
    }
  }

  log(`people: ${people.size}   distinct issuers: ${issuerCiks.size}`);

  // Issuer addresses, then place each on the map via its postcode.
  const centroids = loadCentroids(dataDir);
  if (centroids.size === 0) {
    throw new Error(
      `No ZIP centroids at ${dataDir}/zcta-centroids.tsv. Run scripts/fetch-centroids.mjs first.`,
    );
  }

  const issuers = new Map();
  let done = 0;
  let placed = 0;

  for (const cik of issuerCiks) {
    const issuer = await fetchIssuer(cik);
    done += 1;
    if (done % 250 === 0) log(`issuers ${done}/${issuerCiks.size} (${placed} placed)`);
    if (!issuer) continue;

    const zip = String(issuer.address.zip || "").slice(0, 5);
    const centroid = centroids.get(zip.padStart(5, "0"));
    if (centroid) placed += 1;

    issuers.set(cik, {
      ...issuer,
      lat: centroid?.lat ?? null,
      lng: centroid?.lng ?? null,
    });
  }

  const output = {
    meta: {
      built: true,
      builtAt: new Date().toISOString(),
      quarter,
      people: people.size,
      issuers: issuers.size,
      issuersPlaced: placed,
      source: "SEC Forms 3/4/5 quarterly datasets + EDGAR submissions + Census ZCTA gazetteer",
    },
    people: [...people.values()].map((person) => ({
      ...person,
      roles: [...person.roles].filter(Boolean),
      titles: [...person.titles],
    })),
    issuers: [...issuers.values()],
  };

  const target = path.join(dataDir, "index.json");
  fs.writeFileSync(target, JSON.stringify(output));
  log(`wrote ${target} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
  fs.rmSync(workDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("[build-index] failed:", error.message);
  process.exit(1);
});
