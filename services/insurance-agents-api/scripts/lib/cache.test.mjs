import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { queryCache, saveSnapshot, loadSnapshot, SCHEMA_VERSION } from "./cache.mjs";

const tmpFile = () => path.join(os.tmpdir(), `ins-cache-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

test("snapshot round-trips the query cache", async () => {
  const file = tmpFile();
  queryCache.set("v1|c23p5p|25", { ranked: [{ id: "a1", name: "Whims Insurance" }], total: 1 });
  const saved = await saveSnapshot(file);
  assert.ok(saved.entries >= 1);

  queryCache.set("v1|c23p5p|25", undefined); // clobber in memory
  const restored = await loadSnapshot(file);
  assert.ok(restored.restored >= 1);
  assert.equal(queryCache.get("v1|c23p5p|25").ranked[0].name, "Whims Insurance");
  await fs.rm(file, { force: true });
});

test("a missing snapshot starts cold, not erroring", async () => {
  const result = await loadSnapshot(path.join(os.tmpdir(), "nope-ins.json"));
  assert.equal(result.restored, 0);
  assert.equal(result.error, "no snapshot yet");
});

test("a corrupt snapshot is survivable", async () => {
  const file = tmpFile();
  await fs.writeFile(file, "{ broken", "utf8");
  const result = await loadSnapshot(file);
  assert.equal(result.restored, 0);
  assert.ok(result.error);
  await fs.rm(file, { force: true });
});

test("a snapshot from an older schema version is discarded", async () => {
  const file = tmpFile();
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      schemaVersion: SCHEMA_VERSION - 1,
      savedAt: new Date().toISOString(),
      caches: [{ name: "query", entries: [["old", { ranked: [] }, Date.now() + 60_000]] }],
    }),
    "utf8",
  );
  const result = await loadSnapshot(file);
  assert.equal(result.restored, 0);
  assert.match(result.error, /schemaVersion/);
  await fs.rm(file, { force: true });
});

test("expiry is an absolute timestamp, so a restart cannot extend a stale entry", async () => {
  const file = tmpFile();
  queryCache.set("v1|ttlcheck|25", { ranked: [] });
  await saveSnapshot(file);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const entry = raw.caches.flatMap((c) => c.entries).find(([k]) => k === "v1|ttlcheck|25");
  assert.ok(entry && entry[2] > Date.now());
  await fs.rm(file, { force: true });
});
