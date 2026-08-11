#!/usr/bin/env node
/**
 * Build the Florida Form 6 net-worth roster.
 *
 *   node scripts/build-florida.mjs --year 2025 [--max 500]
 *
 * Two calls per filer: the roster API for identity, and the PDF for the one number.
 * Free, keyless. Machine-readable filings begin at form year 2023 — earlier ones are
 * scans with no text layer, and `extractNetWorth` correctly returns null for them.
 *
 * Requires python3 with pypdf for text extraction (already present in the image).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { config } from "./lib/config.mjs";
import { buildFiler, extractNetWorth, rankByNetWorth } from "./lib/florida.mjs";

const BASE = "https://disclosure.floridaethics.gov";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const log = (...parts) => console.log("[florida]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = { "user-agent": config.sec.userAgent };

/**
 * The roster API silently ignores `lastName` and `formYear` and echoes its real
 * parameter names back at you — they are `filterBy*`, and paging is mandatory. Omit the
 * paging and it returns nothing at all.
 */
async function fetchRoster(year, pageNumber, pageSize) {
  const url =
    `${BASE}/api/PublicFiling/SearchPublicFilings?filterByFormYear=${year}` +
    `&filterByFormTypeCode=6&pageNumber=${pageNumber}&pageSize=${pageSize}` +
    `&sortColumn=LastName&sortDirection=asc`;

  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  return response.json();
}

/** Extract a PDF's text layer via pypdf. Returns "" when the file has none (a scan). */
function pdfText(file) {
  try {
    return execFileSync("python3", ["-c", `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
print("\\n".join((p.extract_text() or "") for p in r.pages))
`, file], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

async function main() {
  const year = arg("year", "2025");
  const max = Number(arg("max", "")) || Infinity;
  const dataDir = path.resolve(arg("out", config.dataDir));
  fs.mkdirSync(dataDir, { recursive: true });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "florida-"));

  // The filings endpoint returns one row per organisation, so a filer with three
  // affiliations appears three times. Dedupe on filingId before spending a PDF fetch.
  const seen = new Map();
  for (let page = 1; page <= 40; page += 1) {
    const body = await fetchRoster(year, page, 250);
    const rows = body?.data || [];
    if (rows.length === 0) break;
    for (const rowData of rows) {
      const id = rowData.filingId ?? rowData.pid;
      if (id && !seen.has(id)) seen.set(id, rowData);
    }
    log(`roster page ${page}: ${seen.size} distinct filings so far`);
    if (seen.size >= max) break;
    await sleep(150);
  }

  const targets = [...seen.values()].slice(0, Number.isFinite(max) ? max : undefined);
  log(`fetching ${targets.length} filings`);

  const filers = [];
  let scanned = 0;
  let done = 0;

  for (const roster of targets) {
    const id = roster.filingId ?? roster.pid;
    const file = path.join(work, `${id}.pdf`);

    try {
      const response = await fetch(`${BASE}/api/Report/RenderPdf/${id}/False`, { headers });
      if (response.ok) {
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
        const netWorth = extractNetWorth(pdfText(file));
        // null means a scan with no text layer, never a net worth of zero.
        if (netWorth == null) scanned += 1;
        else filers.push(buildFiler(roster, netWorth));
        fs.unlinkSync(file);
      }
    } catch { /* one unreadable filing must not end the run */ }

    done += 1;
    await sleep(200);
    if (done % 50 === 0) log(`${done}/${targets.length} — ${filers.length} with a figure, ${scanned} unreadable`);
  }

  const ranked = rankByNetWorth(filers);
  const output = {
    meta: {
      builtAt: new Date().toISOString(),
      formYear: Number(year),
      filingsSeen: targets.length,
      withNetWorth: ranked.length,
      unreadable: scanned,
      partial: Number.isFinite(max) && seen.size >= max,
      source: "Florida Form 6 — Art. II §8(j)(1), Fla. Const.",
      note: "Only the sworn net-worth figure is extracted. Asset, liability and income schedules are never read or stored; Form 6 prints real property by street address.",
    },
    people: ranked,
  };

  const target = path.join(dataDir, "florida-net-worth.json");
  fs.writeFileSync(target, JSON.stringify(output));
  log(`wrote ${target}: ${ranked.length} sworn net-worth figures`);
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("[florida] failed:", error.message);
  process.exit(1);
});
