#!/usr/bin/env node
/**
 * Build the Form ADV Schedule A/B owner roster.
 *
 *   node scripts/build-adv-owners.mjs --zip /path/to/adv-filing-data-…-part1.zip
 *
 * The source is a 669 MB archive containing IA_Schedule_A_B_20111105_20241231.csv, which
 * is ~337 MB uncompressed and around 3.1 million rows. It is streamed line by line
 * rather than read into memory, and only rows for natural persons are kept.
 *
 * The archive is the ONLY place these owner records exist in bulk. The current monthly
 * ADV zip is a firm roster with no owner fields, and the daily XML compilation feed has
 * no Schedule elements at all — see the correction in
 * services/ria-identity-api/docs/DATA-INVENTORY.md.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";

import { config } from "./lib/config.mjs";
import { buildOwners, isIndividual, parseCsvLine } from "./lib/adv-owners.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const log = (...parts) => console.log("[adv-owners]", ...parts);

/** Locate the Schedule A/B member inside the archive without extracting everything. */
function findMember(zip, pattern) {
  const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listing.split("\n").map((n) => n.trim()).filter(Boolean).filter((n) => pattern.test(n));
}

/**
 * Stream one zip member through a line reader.
 *
 * `unzip -p` writes the member to stdout, so a 337 MB CSV never lands on disk and never
 * sits in memory as a single string.
 */
async function* streamMember(zip, member) {
  const child = spawn("unzip", ["-p", zip, member], { stdio: ["ignore", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

async function main() {
  const zip = arg("zip", null);
  if (!zip || !fs.existsSync(zip)) {
    throw new Error("Pass --zip <path to adv-filing-data-…-part1.zip>. Download it from sec.gov first.");
  }

  const dataDir = path.resolve(arg("out", config.dataDir));
  fs.mkdirSync(dataDir, { recursive: true });

  const members = findMember(zip, /Schedule_A_B.*\.csv$/i);
  if (members.length === 0) throw new Error("No Schedule A/B CSV inside that archive");
  log(`members: ${members.join(", ")}`);

  const rows = [];
  let seen = 0;
  let individuals = 0;

  for (const member of members) {
    log(`streaming ${member}`);

    /**
     * The header is read PER MEMBER, not once for the archive.
     *
     * Both Schedule A/B files carry an identical header, so hoisting this out of the
     * loop appears to work — but it makes the second file's header line arrive as a
     * data row. Today that row survives only because its `DE/FE/I` cell reads
     * "DE/FE/I" and fails the individual filter, which is luck rather than logic.
     */
    let header = null;

    for await (const line of streamMember(zip, member)) {
      if (!line.trim()) continue;

      const cells = parseCsvLine(line);
      if (!header) {
        header = cells.map((h) => h.replace(/^"|"$/g, "").trim());
        continue;
      }

      seen += 1;
      const row = {};
      for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? "";

      // Filter to natural persons here rather than after collecting: entities are the
      // majority of 3.1m rows and holding them all would be gratuitous.
      if (!isIndividual(row)) continue;
      individuals += 1;
      rows.push(row);

      if (seen % 500000 === 0) log(`${seen.toLocaleString()} rows read, ${individuals.toLocaleString()} individuals`);
    }
  }

  log(`read ${seen.toLocaleString()} rows, ${individuals.toLocaleString()} individual rows`);

  const people = buildOwners(rows);
  people.sort((a, b) => (b.largestOwnership?.min ?? -1) - (a.largestOwnership?.min ?? -1));

  const output = {
    meta: {
      builtAt: new Date().toISOString(),
      rowsSeen: seen,
      individualRows: individuals,
      people: people.length,
      withCrd: people.filter((p) => p.crd).length,
      withAmbiguousCode: people.filter((p) => p.hasAmbiguousCode).length,
      source: "SEC Form ADV Schedule A/B (direct and indirect owners), bulk archive 2011-11-05 to 2024-12-31",
      coverageNote:
        "The archive ends 2024-12-31. Owner data from 2025 onward is only on the per-firm ADV Part 1 PDF; the current monthly bulk zip and the daily XML feed carry no Schedule sections.",
      ownershipNote:
        "Ownership is a BAND, not a figure. Code F appears on the older form scale and is not defined by the current legend, so it is reported as ambiguous and excluded from largestOwnership rather than guessed.",
      geo: "none — Schedule A/B contains no address of any kind",
    },
    people,
  };

  const target = path.join(dataDir, "adv-owners.json");
  fs.writeFileSync(target, JSON.stringify(output));
  log(`wrote ${target}: ${people.length.toLocaleString()} people (${output.meta.withCrd.toLocaleString()} with a CRD)`);
}

main().catch((error) => {
  console.error("[adv-owners] failed:", error.message);
  process.exit(1);
});
