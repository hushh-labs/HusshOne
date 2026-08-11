#!/usr/bin/env node
/**
 * Build the Form D roster — officers and directors of private companies that raised.
 *
 *   node scripts/build-formd.mjs --quarters 2026/QTR2 [--max 2000]
 *
 * Source: EDGAR's quarterly form index lists every filing; each Form D has a
 * primary_doc.xml with a structured relatedPersonsList. Free, no key, SEC rate limits
 * apply (a descriptive User-Agent is mandatory or they return 403).
 *
 * This produces a NAME/COMPANY lookup, not map data. See the note in lib/formd.mjs for
 * why Form D issuers are never geocoded.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "./lib/config.mjs";
import { buildRoster, parseFormD } from "./lib/formd.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const log = (...parts) => console.log("[form-d]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const headers = { "user-agent": config.sec.userAgent };

/** Stay well inside the SEC's 10/second ceiling; being blocked costs far more than waiting. */
const PACE_MS = 130;

async function fetchText(url, { attempts = 3 } = {}) {
  let wait = 3000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.ok) return response.text();
    if (response.status !== 429 && response.status < 500) return null;
    await sleep(wait);
    wait *= 2;
  }
  return null;
}

/** Pull every Form D accession from a quarterly form index. */
async function listFormD(quarter) {
  const url = `https://www.sec.gov/Archives/edgar/full-index/${quarter}/form.idx`;
  log(`fetching index ${url}`);
  const idx = await fetchText(url);
  if (!idx) throw new Error(`Could not fetch the form index for ${quarter}`);

  const out = [];
  for (const line of idx.split("\n")) {
    // Fixed-width: form type, company, CIK, date, filename. Match "D" exactly so that
    // D/A amendments and every other form starting with D are not swept in.
    if (!/^D\s/.test(line)) continue;
    const file = line.trim().split(/\s+/).pop();
    if (!file || !file.endsWith(".txt")) continue;

    const match = /edgar\/data\/(\d+)\/(\d{10}-\d{2}-\d{6})\.txt$/.exec(file);
    if (!match) continue;
    out.push({ cik: match[1], accession: match[2] });
  }
  return out;
}

async function main() {
  const quarters = arg("quarters", "2026/QTR2").split(",").map((q) => q.trim());
  const max = Number(arg("max", "")) || Infinity;
  const dataDir = path.resolve(arg("out", config.dataDir));
  fs.mkdirSync(dataDir, { recursive: true });

  let accessions = [];
  for (const quarter of quarters) accessions.push(...(await listFormD(quarter)));
  log(`found ${accessions.length} Form D filings`);

  if (Number.isFinite(max)) accessions = accessions.slice(0, max);

  const filings = [];
  let done = 0;
  let skipped = 0;

  for (const { cik, accession } of accessions) {
    const bare = accession.replace(/-/g, "");
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${bare}/primary_doc.xml`;

    const xml = await fetchText(url);
    await sleep(PACE_MS);
    done += 1;

    const parsed = xml ? parseFormD(xml, { accession }) : null;
    if (parsed) filings.push(parsed);
    else skipped += 1;

    if (done % 200 === 0) log(`${done}/${accessions.length} fetched, ${filings.length} usable`);
  }

  const roster = buildRoster(filings);

  const output = {
    meta: {
      builtAt: new Date().toISOString(),
      quarters,
      filingsSeen: accessions.length,
      filingsParsed: filings.length,
      filingsSkipped: skipped,
      people: roster.length,
      partial: Number.isFinite(max) && accessions.length >= max,
      source: "SEC Form D (Regulation D) related-persons disclosures",
      geo: "city and state only — Form D issuers are never geocoded, see lib/formd.mjs",
    },
    people: roster,
  };

  const target = path.join(dataDir, "form-d.json");
  fs.writeFileSync(target, JSON.stringify(output));
  log(`wrote ${target}: ${roster.length} people from ${filings.length} filings`);
}

main().catch((error) => {
  console.error("[form-d] failed:", error.message);
  process.exit(1);
});
