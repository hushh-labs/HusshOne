import { test } from "node:test";
import assert from "node:assert/strict";
import {
  streamIngestRecords,
  discoverLatest,
  ingestFile,
  runRefreshCycle,
} from "./pipeline.mjs";

// Minimal NPPES header + rows as raw CSV text (quoted, as NPPES ships them).
const HEADER =
  '"NPI","Entity Type Code","Provider Organization Name (Legal Business Name)",' +
  '"Provider Business Practice Location Address State Name",' +
  '"Provider Business Practice Location Address Postal Code",' +
  '"Healthcare Provider Taxonomy Code_1","Healthcare Provider Primary Taxonomy Switch_1"';
const ROW1 = '"1234567890","1","","WA","98033","207Q00000X","Y"';
const ROW2 = '"1999999999","2","ACME, INC","CA","90001","261Q00000X","Y"';

test("streamIngestRecords parses header + rows and batches to onBatch", async () => {
  const batches = [];
  const onBatch = async (b) => {
    batches.push(b.map((r) => r.npi));
    return { upserted: b.length, inserted: b.length };
  };
  const chunks = [HEADER + "\n" + ROW1 + "\n" + ROW2 + "\n"];
  const { rowsSeen, rowsUpserted } = await streamIngestRecords(chunks, { batchSize: 10, onBatch });
  assert.equal(rowsSeen, 2);
  assert.equal(rowsUpserted, 2);
  assert.deepEqual(batches, [["1234567890", "1999999999"]]);
});

test("streamIngestRecords reassembles a record split across chunks and honors batchSize", async () => {
  const batches = [];
  const onBatch = async (b) => {
    batches.push(b.length);
    return { upserted: b.length };
  };
  // Split ROW1 in the middle; feed the header, then the two halves, then ROW2.
  const full = HEADER + "\n" + ROW1 + "\n" + ROW2 + "\n";
  const mid = Math.floor(full.length / 2);
  const chunks = [full.slice(0, mid), full.slice(mid)];
  const { rowsSeen } = await streamIngestRecords(chunks, { batchSize: 1, onBatch });
  assert.equal(rowsSeen, 2);
  // batchSize 1 => two separate flushes.
  assert.deepEqual(batches, [1, 1]);
});

test("streamIngestRecords keeps commas inside quoted fields intact", async () => {
  let captured = null;
  const onBatch = async (b) => {
    captured = b;
    return { upserted: b.length };
  };
  await streamIngestRecords([HEADER + "\n" + ROW2 + "\n"], { batchSize: 10, onBatch });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].organizationName, "ACME, INC"); // comma preserved
  assert.equal(captured[0].entityType, "organization");
});

test("streamIngestRecords stops at maxRows and reports capped", async () => {
  const onBatch = async (b) => ({ upserted: b.length });
  const { rowsSeen, capped } = await streamIngestRecords([HEADER + "\n" + ROW1 + "\n" + ROW2 + "\n"], {
    batchSize: 10,
    maxRows: 1,
    onBatch,
  });
  assert.equal(rowsSeen, 1);
  assert.equal(capped, true);
});

test("discoverLatest wraps the pure discovery over injected HTML", async () => {
  const found = await discoverLatest({
    fetchIndexHtml: async () => '<a href="./NPPES_Data_Dissemination_April_2026.zip">x</a>',
  });
  assert.equal(found.monthly.filename, "NPPES_Data_Dissemination_April_2026.zip");
  assert.equal(found.weekly, null);
});

test("ingestFile skips a file already ingested", async () => {
  const r = await ingestFile({
    csvPath: "/tmp/npidata_pfile_x.csv",
    deps: { isFileIngested: async () => true },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.filename, "npidata_pfile_x.csv");
});

test("ingestFile records a run and streams a local CSV (deps injected)", async () => {
  const calls = {};
  const r = await ingestFile({
    csvPath: "/tmp/npidata_pfile_y.csv",
    kind: "bulk",
    deps: {
      isFileIngested: async () => false,
      startIngestRun: async (a) => {
        calls.start = a;
        return 7;
      },
      finishIngestRun: async (id, res) => {
        calls.finish = { id, res };
      },
      ingestCsvFile: async (p, opts) => {
        calls.ingest = { p, opts };
        return { rowsSeen: 5, rowsUpserted: 5, capped: false };
      },
    },
  });
  assert.equal(r.skipped, false);
  assert.equal(r.rowsSeen, 5);
  assert.equal(calls.start.kind, "bulk");
  assert.equal(calls.finish.id, 7);
  assert.equal(calls.finish.res.ok, true);
  assert.equal(calls.finish.res.rowsUpserted, 5);
  assert.equal(calls.ingest.opts.source, "nppes_bulk");
});

test("runRefreshCycle ingests the discovered monthly then weekly", async () => {
  const seen = [];
  const res = await runRefreshCycle({
    discoverLatest: async () => ({
      monthly: { url: "u1", filename: "NPPES_Data_Dissemination_April_2026.zip" },
      weekly: { url: "u2", filename: "NPPES_Data_Dissemination_041326_041926_Weekly_V2.zip" },
    }),
    ingestFile: async ({ filename, kind }) => {
      seen.push({ filename, kind });
      return { skipped: false, filename };
    },
  });
  assert.equal(res.ingested.length, 2);
  assert.equal(seen[0].kind, "bulk");
  assert.equal(seen[1].kind, "weekly");
});
