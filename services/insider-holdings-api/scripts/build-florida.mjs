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
 * Requires python3 with pypdf in the dedicated builder environment. The serving image
 * intentionally stays Node-only and never rebuilds filings on its request path.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { config } from "./lib/config.mjs";
import { buildFiler, extractNetWorth, rankByNetWorth } from "./lib/florida.mjs";

const BASE = "https://disclosure.floridaethics.gov";
export const MAX_FLORIDA_PDF_BYTES = 10 * 1024 * 1024;
const PDF_CONTENT_TYPE = "application/pdf";
const MAX_FIELD_WINDOW_CHARACTERS = 256;

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

/**
 * Text-extract page one only, then emit at most the bounded net-worth field window.
 * No other PDF text crosses the Python process boundary.
 */
export function pdfNetWorthFieldText(file) {
  try {
    return execFileSync("python3", ["-c", `
import re
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
if not r.pages:
    sys.stdout.write("")
else:
    text = r.pages[0].extract_text() or ""
    field = re.search(
        r"net\\s*worth\\s*as\\s*of[\\s\\S]{0,160}?\\(?\\s*-?\\s*\\$\\s*[\\d,]+(?:\\.\\d{2})?\\s*\\)?",
        text,
        re.IGNORECASE,
    )
    sys.stdout.write((field.group(0) if field else "")[:${MAX_FIELD_WINDOW_CHARACTERS}])
`, file], {
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** Read a PDF response through a hard streaming bound and validate its media type/magic. */
export async function readPdfWithinLimit(response, maxBytes = MAX_FLORIDA_PDF_BYTES) {
  if (!response?.ok) throw new Error("Florida filing response was not successful");
  const contentType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== PDF_CONTENT_TYPE) {
    throw new Error("Florida filing response was not application/pdf");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength != null) {
    if (!/^\d+$/.test(contentLength)) throw new Error("Florida filing had invalid length");
    if (Number(contentLength) > maxBytes) throw new Error("Florida filing exceeded size limit");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Florida filing response had no readable body");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("size limit exceeded");
      throw new Error("Florida filing exceeded size limit");
    }
    chunks.push(Buffer.from(value));
  }

  const pdf = Buffer.concat(chunks, total);
  if (pdf.length < 5 || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Florida filing did not contain PDF magic bytes");
  }
  return pdf;
}

/** Persist with mode 0600 only for extraction, and remove the file on every exit path. */
export async function extractNetWorthFromPdfResponse(
  response,
  file,
  { fieldExtractor = pdfNetWorthFieldText, maxBytes = MAX_FLORIDA_PDF_BYTES } = {},
) {
  const pdf = await readPdfWithinLimit(response, maxBytes);
  try {
    fs.writeFileSync(file, pdf, { mode: 0o600 });
    return extractNetWorth(fieldExtractor(file));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function main() {
  const year = arg("year", "2025");
  const max = Number(arg("max", "")) || Infinity;
  const dataDir = path.resolve(arg("out", config.dataDir));
  fs.mkdirSync(dataDir, { recursive: true });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "florida-"));
  try {
    // The filings endpoint returns one row per organisation, so a filer with three
    // affiliations appears three times. Dedupe on filingId before spending a PDF fetch.
    const seen = new Map();
    for (let page = 1; page <= 40; page += 1) {
      const body = await fetchRoster(year, page, 250);
      const rows = body?.data || [];
      if (rows.length === 0) break;
      for (const rowData of rows) {
        const id = Number(rowData.filingId ?? rowData.pid);
        if (Number.isSafeInteger(id) && id > 0 && !seen.has(id)) seen.set(id, rowData);
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
      const id = Number(roster.filingId ?? roster.pid);
      const file = path.join(work, `${id}.pdf`);

      try {
        const response = await fetch(`${BASE}/api/Report/RenderPdf/${id}/False`, {
          headers,
          redirect: "error",
        });
        if (!response.ok) {
          scanned += 1;
        } else {
          const netWorth = await extractNetWorthFromPdfResponse(response, file);
          // null means a scan with no text layer, never a net worth of zero.
          if (netWorth == null) scanned += 1;
          else filers.push(buildFiler(roster, netWorth));
        }
      } catch {
        // An oversized, non-PDF, unreadable, or failed filing must not end the run.
        scanned += 1;
      } finally {
        fs.rmSync(file, { force: true });
      }

      done += 1;
      await sleep(200);
      if (done % 50 === 0) {
        log(
          `${done}/${targets.length} — ${filers.length} with a figure, `
          + `${scanned} unreadable`,
        );
      }
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
        note: "Only a bounded net-worth field window from page one is emitted by the "
          + "extractor. Raw PDFs and asset, liability, and income schedules are not "
          + "retained or emitted.",
      },
      people: ranked,
    };

    const target = path.join(dataDir, "florida-net-worth.json");
    fs.writeFileSync(target, JSON.stringify(output));
    log(`wrote ${target}: ${ranked.length} sworn net-worth figures`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[florida] failed:", error.message);
    process.exit(1);
  });
}
