// Ingest orchestration: turn an SEC Form ADV compilation file into rows in `firms` /
// `advisers`, and drive the "is a newer compilation available?" refresh decision.
// This module touches the DB (pg) + network (fetch), so it is NOT unit-tested — the
// pure parsing/mapping/discovery logic it calls lives in adv.mjs (which is tested).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { config } from "./config.mjs";
import {
  createCsvRecordAssembler,
  buildHeaderIndex,
  mapAdvRowToFirm,
  mapAdvRowToAdviser,
  FIRM_FIELD_ALIASES,
  ADVISER_FIELD_ALIASES,
  looksLikeXml,
  createXmlElementExtractor,
  mapFirmXmlElement,
  mapAdviserXmlElement,
  discoverLatestCompilationUrls,
  downloadToFile,
} from "./adv.mjs";
import {
  upsertFirm,
  upsertAdviser,
  startIngestRun,
  finishIngestRun,
  lastSuccessfulIngest,
  countFirms,
} from "./db.mjs";

// Peek the first bytes to reject an XML feed before we stream it as CSV.
async function readSample(filePath, bytes = 512) {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

// Stream-parse one CSV compilation file and upsert every row. First complete record is
// the header; the rest map to firm/adviser records via adv.mjs. Records an ingest_runs
// row (start → finish) so the run is resumable and its freshness is queryable. Returns
// { kind, sourceFile, rowsSeen, rowsUpserted, ok }.
export async function ingestCsvFile({ filePath, kind, sourceFile, deps = {} }) {
  const upFirm = deps.upsertFirm || upsertFirm;
  const upAdviser = deps.upsertAdviser || upsertAdviser;
  const startRun = deps.startIngestRun || startIngestRun;
  const finishRun = deps.finishIngestRun || finishIngestRun;
  const label = sourceFile || path.basename(filePath);

  const mapRow = kind === "firms" ? mapAdvRowToFirm : mapAdvRowToAdviser;
  const aliases = kind === "firms" ? FIRM_FIELD_ALIASES : ADVISER_FIELD_ALIASES;
  const upsert = kind === "firms" ? upFirm : upAdviser;

  const runId = await startRun({ kind, sourceFile: label });
  let rowsSeen = 0;
  let rowsUpserted = 0;
  try {
    // Format guard: the live SEC feed is XML. Refuse to parse it as CSV rather than
    // writing garbage — a clear, auditable failure instead of a silent corruption.
    const sample = await readSample(filePath);
    if (looksLikeXml(sample)) {
      throw new Error(
        `unsupported format for ${label}: expected CSV but content is XML — the live SEC Form ADV feed is XML (see README). Provide a CSV export or convert the XML first.`,
      );
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    const assembler = createCsvRecordAssembler();
    let headers = null;
    let headerIndex = null;

    const handle = async (fields) => {
      if (headers == null) {
        headers = fields.map((h) => String(h ?? "").trim());
        headerIndex = buildHeaderIndex(headers, aliases);
        return;
      }
      rowsSeen++;
      const rec = mapRow(headers, fields, headerIndex);
      if (!rec) return;
      rec.source = kind;
      const out = await upsert(rec);
      if (out) rowsUpserted++;
    };

    for await (const line of rl) {
      const fields = assembler.push(line);
      if (fields == null) continue; // record continues on the next physical line
      await handle(fields);
    }
    const tail = assembler.flush();
    if (tail) await handle(tail);

    await finishRun(runId, { rowsSeen, rowsUpserted, ok: true });
    return { kind, sourceFile: label, rowsSeen, rowsUpserted, ok: true };
  } catch (err) {
    await finishRun(runId, { rowsSeen, rowsUpserted, ok: false, error: err.message }).catch(() => {});
    throw err;
  }
}

// Stream-parse one XML compilation file (the SEC's live format) and upsert every element.
// Emits the same firm/adviser records the CSV path does, so the DB layer is unchanged.
// Files are read as latin1 (the feed declares ISO-8859-1). Records an ingest_runs row.
export async function ingestXmlFile({ filePath, kind, sourceFile, deps = {} }) {
  const upFirm = deps.upsertFirm || upsertFirm;
  const upAdviser = deps.upsertAdviser || upsertAdviser;
  const startRun = deps.startIngestRun || startIngestRun;
  const finishRun = deps.finishIngestRun || finishIngestRun;
  const label = sourceFile || path.basename(filePath);

  const tag = kind === "firms" ? "Firm" : "Indvl";
  const mapEl = kind === "firms" ? mapFirmXmlElement : mapAdviserXmlElement;
  const upsert = kind === "firms" ? upFirm : upAdviser;

  const runId = await startRun({ kind, sourceFile: label });
  let rowsSeen = 0;
  let rowsUpserted = 0;
  try {
    const extractor = createXmlElementExtractor(tag);
    const stream = fs.createReadStream(filePath, { encoding: "latin1" });
    for await (const chunk of stream) {
      for (const block of extractor.push(chunk)) {
        rowsSeen++;
        const rec = mapEl(block);
        if (!rec) continue;
        rec.source = kind;
        const out = await upsert(rec);
        if (out) rowsUpserted++;
      }
    }
    await finishRun(runId, { rowsSeen, rowsUpserted, ok: true });
    return { kind, sourceFile: label, rowsSeen, rowsUpserted, ok: true };
  } catch (err) {
    await finishRun(runId, { rowsSeen, rowsUpserted, ok: false, error: err.message }).catch(() => {});
    throw err;
  }
}

// Route a downloaded feed file to the right parser by peeking its first bytes. The live
// SEC feed is XML; a manual CSV export still works via the original path.
export async function ingestFile(args) {
  const sample = await readSample(args.filePath);
  if (looksLikeXml(sample)) return ingestXmlFile(args);
  return ingestCsvFile(args);
}

// Extract a .zip (Node has no built-in zip-container reader) with the system `unzip`,
// which the deploy installs. Returns the absolute paths of the extracted *.xml files.
export async function extractZip(zipPath, destDir, deps = {}) {
  const spawnImpl = deps.spawn || spawn;
  await fs.promises.mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawnImpl("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
  });
  const entries = await fs.promises.readdir(destDir);
  return entries
    .filter((e) => e.toLowerCase().endsWith(".xml"))
    .sort()
    .map((e) => path.join(destDir, e));
}

async function ingestLocal(ingest, filePath, kind, log) {
  try {
    return await ingest({ filePath, kind, sourceFile: path.basename(filePath) });
  } catch (err) {
    log({ event: "ingest.error", kind, file: filePath, message: err.message });
    return { kind, sourceFile: path.basename(filePath), ok: false, error: err.message };
  }
}

// Decide whether a discovered compilation is worth (re)ingesting.
async function shouldIngest({ kind, link, firmsEmpty, force, lastIngest, refreshAfterDays }) {
  if (force) return { ingest: true, reason: "forced" };
  if (kind === "firms" && firmsEmpty) return { ingest: true, reason: "firms-empty" };
  const last = await lastIngest(kind);
  if (!last) return { ingest: true, reason: "no-prior-ingest" };
  if (last.source_file && link.name && last.source_file !== link.name) {
    return { ingest: true, reason: "newer-compilation" };
  }
  const ageMs = last.finished_at ? Date.now() - new Date(last.finished_at).getTime() : Infinity;
  if (ageMs >= refreshAfterDays * 24 * 60 * 60 * 1000) return { ingest: true, reason: "refresh-window" };
  return { ingest: false, reason: "up-to-date" };
}

// One full ingest cycle. Either ingest explicit local files (deploy/init handoff, or a
// manual CSV export), or discover → decide → download → ingest the latest compilation.
// Returns { via, results[] }. `deps` allows fixture injection.
export async function runIngestCycle(opts = {}, deps = {}) {
  const discover = deps.discoverLatestCompilationUrls || discoverLatestCompilationUrls;
  const dl = deps.downloadToFile || downloadToFile;
  const ingest = deps.ingestFile || ingestFile;
  const extract = deps.extractZip || extractZip;
  const lastIngest = deps.lastSuccessfulIngest || lastSuccessfulIngest;
  const nFirms = deps.countFirms || countFirms;
  const log = deps.log || ((o) => console.log(JSON.stringify(o)));
  const downloadDir = opts.downloadDir || config.sec.downloadDir;
  const refreshAfterDays = opts.refreshAfterDays ?? config.worker.refreshAfterDays;
  const results = [];

  // Local-file mode.
  if (opts.firmsFile || opts.individualsFile) {
    if (opts.firmsFile) results.push(await ingestLocal(ingest, opts.firmsFile, "firms", log));
    if (opts.individualsFile) results.push(await ingestLocal(ingest, opts.individualsFile, "individuals", log));
    return { via: "local-files", results };
  }

  // Discovery mode.
  const discovery = await discover(deps.discoverDeps || {});
  log({
    event: "ingest.discovered",
    via: discovery.via,
    firm: discovery.firm?.name || null,
    individual: discovery.individual?.name || null,
    verified: discovery.verified !== false,
  });

  const firmsEmpty = (await nFirms()) === 0;
  for (const [kind, link] of [
    ["firms", discovery.firm],
    ["individuals", discovery.individual],
  ]) {
    if (!link) {
      log({ event: "ingest.skip", kind, reason: "no-link-discovered" });
      continue;
    }
    const decision = await shouldIngest({ kind, link, firmsEmpty, force: opts.force, lastIngest, refreshAfterDays });
    if (!decision.ingest) {
      log({ event: "ingest.skip", kind, file: link.name, reason: decision.reason });
      results.push({ kind, sourceFile: link.name, skipped: true, reason: decision.reason });
      continue;
    }

    const dest = path.join(downloadDir, link.name);
    let downloaded;
    try {
      downloaded = await dl(link.url, dest, { fetchImpl: deps.fetchImpl, userAgent: config.sec.userAgent });
    } catch (err) {
      log({ event: "ingest.download_error", kind, url: link.url, message: err.message });
      results.push({ kind, sourceFile: link.name, ok: false, error: err.message });
      continue;
    }

    // The individual feed ships as a .zip containing ~20 XML parts. Extract with the
    // system `unzip`, then ingest each part (the firm feed is a single gunzipped XML).
    if (downloaded.needsUnzip) {
      const extractDir = path.join(downloadDir, `${link.name.replace(/\.zip$/i, "")}_extracted`);
      let parts;
      try {
        parts = await extract(downloaded.path, extractDir);
      } catch (err) {
        log({ event: "ingest.unzip_error", kind, file: downloaded.path, message: err.message });
        results.push({ kind, sourceFile: link.name, ok: false, error: `unzip: ${err.message}` });
        continue;
      }
      log({ event: "ingest.unzipped", kind, file: downloaded.path, parts: parts.length });
      for (const part of parts) {
        try {
          // Attribute each part's ingest run to the compilation .zip so freshness tracking
          // (shouldIngest ↔ lastSuccessfulIngest) keys off the dated compilation name.
          results.push(await ingest({ filePath: part, kind, sourceFile: link.name }));
        } catch (err) {
          log({ event: "ingest.error", kind, file: part, message: err.message });
          results.push({ kind, sourceFile: link.name, ok: false, error: err.message });
        }
      }
      // Reclaim the ~1 GB of extracted XML once ingested; the .zip stays for audit.
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    try {
      results.push(await ingest({ filePath: downloaded.path, kind, sourceFile: link.name }));
    } catch (err) {
      log({ event: "ingest.error", kind, file: downloaded.path, message: err.message });
      results.push({ kind, sourceFile: link.name, ok: false, error: err.message });
    }
  }
  return { via: discovery.via, results };
}

// Convenience re-exports (pure helpers live in adv.mjs).
export {
  discoverLatestCompilationUrls,
  downloadToFile,
  mapAdvRowToFirm,
  mapAdvRowToAdviser,
} from "./adv.mjs";
