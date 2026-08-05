import test from "node:test";
import assert from "node:assert/strict";
import { pooled } from "./nationwide.mjs";

test("pooled preserves input order regardless of completion order", async () => {
  const out = await pooled(
    [30, 10, 20],
    async (ms) => {
      await new Promise((r) => setTimeout(r, ms / 10));
      return ms;
    },
    3,
  );
  assert.deepEqual(out, [30, 10, 20]);
});

test("pooled isolates a failure to its own slot", async () => {
  const out = await pooled([1, 2, 3], async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  }, 2);
  assert.deepEqual(out, [1, null, 3]);
});
