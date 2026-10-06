// The ingest engine. NPPES ships an ~9GB monthly full-replacement CSV (8M+ rows)
// plus weekly incremental files, so we NEVER load a file into memory: we stream it
// record-by-record and upsert in bounded batches. This module wires together the
// pure helpers in nppes.mjs (parsing/mapping/discovery) with db.mjs (batch upsert +
// ingest-run bookkeeping) and does the network/filesystem I/O (discover → download →
// unzip → stream-ingest). Everything heavy is injectable via `deps` for testing.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";

import { config } from "./config.mjs";
import { parseCsvLine, buildNppesIndex, mapNppesRow, discoverLatestBulkUrl } from "./nppes.mjs";
import {
  upsertProvidersBatch as dbUpsertProvidersBatch,
  startIngestRun,
  finishIngestRun,
  isFileIngested,
} from "./db.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Streaming CSV → provider records → batched upsert
// ---------------------------------------------------------------------------

// Consume an async-iterable of string chunks (a file stream, or a fabricated array
// in tests), split it into logical CSV records (respecting quoted fields that may
// contain commas or embedded newlines), map each data row to a provider record, and
// hand full batches to `onBatch`. The first record is the NPPES header, which builds
// the name→column index. Returns { rowsSeen, rowsUpserted, capped }.
//
// Memory stays flat: only the current partial record + one batch are held at a time.
export async function streamIngestRecords(
  chunkIterable,
  { source = "nppes_bulk", batchSize = config.nppes.batchSize, maxRows = 0, onBatch } = {},
) {
  const upsert = onBatch || dbUpsertProvidersBatch;
  let pending = ""; // characters not yet forming a complete record
  let header = null;
  let idx = null;
  let rowsSeen = 0;
  let rowsUpserted = 0;
  let batch = [];
  let capped = false;

  const flush = async () => {
    if (!batch.length) return;
    const res = await upsert(batch);
    rowsUpserted += (res && res.upserted) || 0;
    batch = [];
  };

  const handleRecord = async (recordRaw) => {
    const record = recordRaw.replace(/\r$/, "");
    if (record === "") return; // skip blank lines
    const fields = parseCsvLine(record);
    if (!header) {
      header = fields;
      idx = buildNppesIndex(fields);
      return;
    }
    rowsSeen++;
    const rec = mapNppesRow(fields, idx, source);
    if (rec) batch.push(rec);
    if (batch.length >= batchSize) await flush();
  };

  for await (const chunk of chunkIterable) {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // `pending` always begins at a record boundary (outside quotes), so quote state
    // is recomputed from position 0 each pass — never carried across chunks (that
    // would double-toggle the re-scanned prefix).
    let inQuotes = false;
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const ch = pending[i];
      // Toggle on every quote: an escaped "" toggles twice (net no-op), correctly
      // keeping us "inside quotes" — so only an UNquoted \n ends a record.
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "\n" && !inQuotes) {
        await handleRecord(pending.slice(start, i));
        start = i + 1;
        if (maxRows && rowsSeen >= maxRows) {
          capped = true;
          break;
        }
      }
    }
    pending = pending.slice(start);
    if (capped) break;
  }

  // Trailing record with no final newline.
  if (!capped && pending.length) await handleRecord(pending);
  await flush();
  return { rowsSeen, rowsUpserted, capped };
}

// Stream-ingest a CSV file on disk (the unzipped npidata pfile).
export async function ingestCsvFile(csvPath, opts = {}) {
  const stream = fs.createReadStream(csvPath, { encoding: "utf8", highWaterMark: 1 << 20 });
  return streamIngestRecords(stream, opts);
}

// ---------------------------------------------------------------------------
// Discovery (parse the NPPES index for the newest monthly + weekly zips)
// ---------------------------------------------------------------------------

export async function fetchIndexHtml() {
  const res = await fetch(config.nppes.indexUrl, {
    headers: { "User-Agent": config.nppes.userAgent, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`NPPES index HTTP ${res.status}`);
  return res.text();
}

// Network wrapper around the pure discoverLatestBulkUrl(). Returns { monthly, weekly }.
export async function discoverLatest(deps = {}) {
  const getHtml = deps.fetchIndexHtml || fetchIndexHtml;
  const html = await getHtml();
  return discoverLatestBulkUrl(html, config.nppes.baseUrl);
}

// ---------------------------------------------------------------------------
// Download + unzip
// ---------------------------------------------------------------------------

// The provider data file inside an NPPES zip. Excludes the *_FileHeader.csv and the
// endpoint/othername/practice-location sidecar files.
const PFILE_RE = /^npidata_pfile_.*\.csv$/i;
const FILEHEADER_RE = /fileheader/i;

// Download a zip to the download dir and unzip it (shelling out to the system
// `unzip`, exactly as the fleet fetches GeoNames — Node has no built-in unzip).
// Returns { csvPath, cleanup } where cleanup removes the downloaded zip + extracted
// csv to reclaim disk between monthly drops.
export async function downloadAndUnzip(url, filename, deps = {}) {
  const dir = config.nppes.downloadDir;
  await fs.promises.mkdir(dir, { recursive: true });
  const name = filename || url.split("/").pop() || "nppes_download.zip";
  const zipPath = path.join(dir, name);

  console.log(JSON.stringify({ event: "nppes.download_start", url, zipPath }));
  const res = await fetch(url, { headers: { "User-Agent": config.nppes.userAgent } });
  if (!res.ok || !res.body) throw new Error(`NPPES download HTTP ${res.status} for ${url}`);
  await fs.promises.rm(zipPath, { force: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    Readable.fromWeb(res.body).pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
  });
  console.log(JSON.stringify({ event: "nppes.download_done", zipPath }));

  // List the zip contents, pick the pfile, extract just it.
  const run = deps.execFileAsync || execFileAsync;
  const { stdout } = await run("unzip", ["-Z1", zipPath]);
  const entries = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const pfile = entries.find((e) => PFILE_RE.test(path.basename(e)) && !FILEHEADER_RE.test(e));
  if (!pfile) throw new Error(`No npidata pfile found in ${name} (entries: ${entries.slice(0, 5).join(", ")})`);

  await run("unzip", ["-o", zipPath, pfile, "-d", dir]);
  const csvPath = path.join(dir, pfile);
  console.log(JSON.stringify({ event: "nppes.unzip_done", csvPath }));

  const cleanup = async () => {
    await fs.promises.rm(zipPath, { force: true }).catch(() => {});
    await fs.promises.rm(csvPath, { force: true }).catch(() => {});
  };
  return { csvPath, cleanup };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Ingest one bulk/weekly file end-to-end, recording an ingest_runs row so restarts
// are resumable and idempotent. If `csvPath` is given we ingest that local file
// directly (VM init unzips the monthly file once; local dev points NPPES_CSV_PATH
// at a sample); otherwise we download+unzip `url`. Skips files already ingested ok.
export async function ingestFile({ url, filename, kind = "bulk", csvPath = null, deps = {} } = {}) {
  const already = deps.isFileIngested || isFileIngested;
  const start = deps.startIngestRun || startIngestRun;
  const finish = deps.finishIngestRun || finishIngestRun;
  const download = deps.downloadAndUnzip || downloadAndUnzip;
  const ingest = deps.ingestCsvFile || ingestCsvFile;

  const label = filename || (csvPath ? path.basename(csvPath) : url);
  if (label && (await already(label))) {
    console.log(JSON.stringify({ event: "ingest.skip_already", file: label }));
    return { skipped: true, filename: label };
  }

  const source = kind === "weekly" ? "nppes_weekly" : "nppes_bulk";
  const runId = await start({ kind, sourceFile: label });
  let cleanup = null;
  try {
    let localCsv = csvPath;
    if (!localCsv) {
      const dl = await download(url, filename, deps);
      localCsv = dl.csvPath;
      cleanup = dl.cleanup;
    }
    console.log(JSON.stringify({ event: "ingest.start", file: label, kind, csvPath: localCsv }));
    const { rowsSeen, rowsUpserted, capped } = await ingest(localCsv, {
      source,
      batchSize: config.nppes.batchSize,
      maxRows: config.nppes.maxRows,
      onBatch: deps.upsertProvidersBatch || dbUpsertProvidersBatch,
    });
    await finish(runId, { rowsSeen, rowsUpserted, ok: true });
    if (cleanup && !deps.keepFiles) await cleanup();
    console.log(JSON.stringify({ event: "ingest.done", file: label, kind, rowsSeen, rowsUpserted, capped }));
    return { skipped: false, filename: label, kind, rowsSeen, rowsUpserted, capped };
  } catch (err) {
    await finish(runId, { ok: false, error: err.message }).catch(() => {});
    console.log(JSON.stringify({ event: "ingest.error", file: label, message: err.message }));
    throw err;
  }
}

// One refresh pass: discover the newest monthly + weekly files and ingest whichever
// hasn't been ingested yet (monthly full first, then the weekly delta). Returns what
// was found and what was ingested/skipped — the worker calls this on a daily cadence.
export async function runRefreshCycle(deps = {}) {
  const discover = deps.discoverLatest || discoverLatest;
  const doIngest = deps.ingestFile || ingestFile;

  const { monthly, weekly } = await discover(deps);
  console.log(
    JSON.stringify({
      event: "refresh.discovered",
      monthly: monthly?.filename || null,
      weekly: weekly?.filename || null,
    }),
  );

  const ingested = [];
  for (const target of [monthly, weekly]) {
    if (!target) continue;
    const kind = /weekly/i.test(target.filename) ? "weekly" : "bulk";
    const r = await doIngest({ url: target.url, filename: target.filename, kind, deps });
    ingested.push(r);
  }
  return { monthly, weekly, ingested };
}
