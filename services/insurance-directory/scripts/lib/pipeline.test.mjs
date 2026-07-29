import { test } from "node:test";
import assert from "node:assert/strict";
import { runStateAdapter } from "./pipeline.mjs";

test("runStateAdapter short-circuits a blocked adapter (no upsert, returns note)", async () => {
  let called = false;
  const adapter = {
    code: "ZZ",
    kind: "blocked",
    note: "no free source",
    // eslint-disable-next-line require-yield
    async *records() {},
  };
  const res = await runStateAdapter(adapter, {
    upsertProducer: async () => {
      called = true;
      return { id: 1, inserted: true };
    },
  });
  assert.deepEqual(res, {
    state: "ZZ",
    kind: "blocked",
    blocked: true,
    note: "no free source",
    seen: 0,
    upserted: 0,
    inserted: 0,
  });
  assert.equal(called, false); // a blocked adapter must never touch the DB
});

test("runStateAdapter streams a working adapter, upserts each, skips nulls, counts inserts", async () => {
  const rec1 = { sourceState: "XX", licenseNo: "1" };
  const rec2 = { sourceState: "XX", licenseNo: "2" };
  const adapter = {
    code: "XX",
    kind: "download",
    async *records() {
      yield rec1;
      yield null; // pipeline must skip falsy records
      yield rec2;
    },
  };
  const seen = new Set();
  const upserts = [];
  const upsertProducer = async (rec) => {
    upserts.push(rec);
    const isNew = !seen.has(rec.licenseNo);
    seen.add(rec.licenseNo);
    return { id: rec.licenseNo, inserted: isNew };
  };
  const res = await runStateAdapter(adapter, { upsertProducer });
  assert.equal(res.blocked, false);
  assert.equal(res.state, "XX");
  assert.equal(res.kind, "download");
  assert.equal(res.seen, 2); // the null was skipped
  assert.equal(res.upserted, 2);
  assert.equal(res.inserted, 2); // two distinct new licenses
  assert.deepEqual(upserts, [rec1, rec2]);
});

test("runStateAdapter counts a merge (existing row) as upserted but not inserted", async () => {
  const adapter = {
    code: "XX",
    kind: "download",
    async *records() {
      yield { sourceState: "XX", licenseNo: "1" };
      yield { sourceState: "XX", licenseNo: "1" }; // same license -> merge
    },
  };
  const upsertProducer = async () => ({ id: 1, inserted: false }); // simulate an existing row
  const res = await runStateAdapter(adapter, { upsertProducer });
  assert.equal(res.seen, 2);
  assert.equal(res.upserted, 2);
  assert.equal(res.inserted, 0);
});

test("runStateAdapter requires an adapter", async () => {
  await assert.rejects(() => runStateAdapter(null, {}), /requires an adapter/);
});
