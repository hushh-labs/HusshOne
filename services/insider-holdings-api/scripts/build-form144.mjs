#!/usr/bin/env node
/**
 * Build the Form 144 liquidity roster.
 *
 *   node scripts/build-form144.mjs --quarters 2026/QTR2 [--max 2000]
 *
 * Same pipeline as Form D: EDGAR's quarterly form index lists every filing, and each
 * Form 144 has a structured primary_doc.xml. Free, keyless, SEC rate limits apply.
 *
 * 2026/QTR2 holds roughly 19,000 Form 144s — more than every Schedule 13D and 13G
 * combined — so a full quarter is a long run. `--max` bounds it.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "./lib/config.mjs";
import { buildLiquidity, parseForm144 } from "./lib/form144.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const log = (...parts) => console.log("[form144]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = { "user-agent": config.sec.userAgent };
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

/** Every Form 144 accession in a quarterly index. */
async function listForm144(quarter) {
  const url = `https://www.sec.gov/Archives/edgar/full-index/${quarter}/form.idx`;
  log(`fetching index ${url}`);
  const idx = await fetchText(url);
  if (!idx) throw new Error(`Could not fetch the form index for ${quarter}`);

  const out = [];
  for (const line of idx.split("\n")) {
    // Match "144" exactly. A prefix match would also sweep in 144A and other forms.
    if (!/^144\s/.test(line)) continue;
    const file = line.trim().split(/\s+/).pop();
    const match = /edgar\/data\/(\d+)\/(\d{10}-\d{2}-\d{6})\.txt$/.exec(file || "");
    if (match) out.push({ cik: match[1], accession: match[2] });
  }
  return out;
}

async function main() {
  const quarters = arg("quarters", "2026/QTR2").split(",").map((q) => q.trim());
  const max = Number(arg("max", "")) || Infinity;
  const dataDir = path.resolve(arg("out", config.dataDir));
  fs.mkdirSync(dataDir, { recursive: true });

  let accessions = [];
  for (const quarter of quarters) accessions.push(...(await listForm144(quarter)));
  log(`found ${accessions.length} Form 144 filings`);
  if (Number.isFinite(max)) accessions = accessions.slice(0, max);

  const notices = [];
  let done = 0;
  let skipped = 0;

  for (const { cik, accession } of accessions) {
    const bare = accession.replace(/-/g, "");
    const xml = await fetchText(`https://www.sec.gov/Archives/edgar/data/${cik}/${bare}/primary_doc.xml`);
    await sleep(PACE_MS);
    done += 1;

    const parsed = xml ? parseForm144(xml, { accession }) : null;
    if (parsed) notices.push(parsed);
    else skipped += 1;

    if (done % 200 === 0) log(`${done}/${accessions.length} fetched, ${notices.length} usable`);
  }

  const people = buildLiquidity(notices);

  const output = {
    meta: {
      builtAt: new Date().toISOString(),
      quarters,
      filingsSeen: accessions.length,
      filingsParsed: notices.length,
      filingsSkipped: skipped,
      people: people.length,
      partial: Number.isFinite(max) && accessions.length >= max,
      source: "SEC Form 144 — notice of proposed sale of restricted or control securities",
      caveat:
        "A Form 144 is a NOTICE OF INTENT to sell, not a completed sale, and the same shares may be noticed more than once. These figures are a liquidity signal and are never summed into a holding.",
    },
    people,
  };

  const target = path.join(dataDir, "form-144.json");
  fs.writeFileSync(target, JSON.stringify(output));
  log(`wrote ${target}: ${people.length} people from ${notices.length} notices`);
}

main().catch((error) => {
  console.error("[form144] failed:", error.message);
  process.exit(1);
});
