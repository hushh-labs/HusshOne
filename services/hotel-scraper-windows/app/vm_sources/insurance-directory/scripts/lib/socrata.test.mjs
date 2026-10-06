import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResourceUrl, streamResourceRows, SocrataRateLimitError } from "./socrata.mjs";

// Build a fake Socrata `.csv` endpoint over an in-memory dataset. The fake honors
// $limit/$offset from the query string exactly like Socrata, so the generator's
// pagination logic is exercised without any network.
function makeFakeFetch(headerCols, dataRows, opts = {}) {
  const calls = [];
  let failuresLeft = opts.failFirst || 0;
  const csvFor = (slice) => {
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headerCols.join(","), ...slice.map((r) => headerCols.map((c) => esc(r[c])).join(","))].join("\n");
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (failuresLeft > 0) {
      failuresLeft--;
      return { ok: false, status: 429, async text() { return "rate limited"; } };
    }
    const u = new URL(url);
    const limit = Number(u.searchParams.get("$limit"));
    const offset = Number(u.searchParams.get("$offset"));
    const slice = dataRows.slice(offset, offset + limit);
    return { ok: true, status: 200, async text() { return csvFor(slice); } };
  };
  return { fetchImpl, calls };
}

const HEADER = ["id", "name"];
const ROWS = [
  { id: "1", name: "Alice" },
  { id: "2", name: "Bob" },
  { id: "3", name: "Cara" },
  { id: "4", name: "Dan" },
  { id: "5", name: "Eve" },
];

test("buildResourceUrl encodes SoQL paging params with a stable order", () => {
  const url = buildResourceUrl({ domain: "data.texas.gov", resourceId: "kxv3-diwf", limit: 100, offset: 200 });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://data.texas.gov/resource/kxv3-diwf.csv");
  assert.equal(u.searchParams.get("$limit"), "100");
  assert.equal(u.searchParams.get("$offset"), "200");
  assert.equal(u.searchParams.get("$order"), ":id");
});

test("streamResourceRows pages through full pages until a short page ends it", async () => {
  const { fetchImpl, calls } = makeFakeFetch(HEADER, ROWS);
  const out = [];
  for await (const row of streamResourceRows({
    domain: "data.texas.gov",
    resourceId: "kxv3-diwf",
    pageSize: 2,
    fetchImpl,
  })) {
    out.push(row);
  }
  assert.deepEqual(out.map((r) => r.name), ["Alice", "Bob", "Cara", "Dan", "Eve"]);
  // 5 rows at pageSize 2 = pages at offset 0, 2, 4 (last returns 1 row -> stop).
  assert.equal(calls.length, 3);
});

test("streamResourceRows honors maxRecords and stops early", async () => {
  const { fetchImpl } = makeFakeFetch(HEADER, ROWS);
  const out = [];
  for await (const row of streamResourceRows({
    domain: "data.texas.gov",
    resourceId: "kxv3-diwf",
    pageSize: 2,
    maxRecords: 3,
    fetchImpl,
  })) {
    out.push(row);
  }
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.name), ["Alice", "Bob", "Cara"]);
});

test("streamResourceRows retries a 429 with backoff, then succeeds", async () => {
  const { fetchImpl, calls } = makeFakeFetch(HEADER, ROWS, { failFirst: 1 });
  const out = [];
  for await (const row of streamResourceRows({
    domain: "data.texas.gov",
    resourceId: "kxv3-diwf",
    pageSize: 5,
    maxBackoffMs: 1, // keep the retry near-instant
    fetchImpl,
  })) {
    out.push(row);
  }
  assert.equal(out.length, 5);
  // 1 failed (retried) call + 1 successful full page + 0 (short page not needed since
  // page returned exactly pageSize=5 and dataset is 5 -> next page is empty -> stop).
  assert.ok(calls.length >= 2);
});

test("streamResourceRows throws on a non-retryable HTTP error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, async text() { return "not found"; } });
  await assert.rejects(
    (async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of streamResourceRows({ domain: "x", resourceId: "y", fetchImpl })) {
        /* consume */
      }
    })(),
    /Socrata HTTP 404/,
  );
});

test("streamResourceRows requires domain + resourceId", async () => {
  await assert.rejects(
    (async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of streamResourceRows({ fetchImpl: async () => ({}) })) {
        /* consume */
      }
    })(),
    /requires \{ domain, resourceId \}/,
  );
  assert.ok(SocrataRateLimitError.prototype instanceof Error);
});
