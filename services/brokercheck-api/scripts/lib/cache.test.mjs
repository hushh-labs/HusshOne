import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { branchGeoCache, profileCache, firmCache, saveSnapshot, loadSnapshot, SCHEMA_VERSION } from "./cache.mjs";

const tmpFile = () => path.join(os.tmpdir(), `bc-cache-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

test("snapshot round-trips the persisted caches", async () => {
  const file = tmpFile();
  branchGeoCache.set("zip:98033", { lat: 47.673156, lng: -122.197628, geoPrecision: "zip_centroid" });
  firmCache.set("firm:149777", { firmName: "MORGAN STANLEY", contact: { phone: "914-225-1000" } });

  const saved = await saveSnapshot(file);
  assert.ok(saved.entries >= 2, `expected >=2 entries, got ${saved.entries}`);

  const restored = await loadSnapshot(file);
  assert.ok(restored.restored >= 2);
  // Values survive intact, not just keys.
  assert.equal(branchGeoCache.get("zip:98033").lat, 47.673156);
  assert.equal(firmCache.get("firm:149777").contact.phone, "914-225-1000");

  await fs.rm(file, { force: true });
});

test("a missing snapshot is not an error — the service just starts cold", async () => {
  const result = await loadSnapshot(path.join(os.tmpdir(), "definitely-does-not-exist-bc.json"));
  assert.equal(result.restored, 0);
  assert.equal(result.error, "no snapshot yet");
});

test("a corrupt snapshot is survivable rather than fatal", async () => {
  const file = tmpFile();
  await fs.writeFile(file, "{ this is not json", "utf8");
  const result = await loadSnapshot(file);
  assert.equal(result.restored, 0);
  assert.ok(result.error);
  await fs.rm(file, { force: true });
});

test("expired entries are not written out, and not restored", async () => {
  const file = tmpFile();
  // profileCache has a 7-day TTL; forge an already-expired entry via the exported shape.
  profileCache.set("crd:expired-test", { name: "GHOST" });
  const snapshot = profileCache.export();
  const forged = {
    version: 1,
    savedAt: new Date().toISOString(),
    caches: [{ name: "profile", entries: snapshot.entries.map(([k, v]) => [k, v, Date.now() - 1000]) }],
  };
  await fs.writeFile(file, JSON.stringify(forged), "utf8");

  const fresh = await loadSnapshot(file);
  assert.equal(fresh.restored, 0, "an expired entry must not come back to life on restart");
  await fs.rm(file, { force: true });
});

test("absolute expiry means a restart cannot extend an entry's life", async () => {
  const file = tmpFile();
  profileCache.set("crd:ttl-check", { name: "X" });
  await saveSnapshot(file);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const entry = raw.caches.flatMap((c) => c.entries).find(([k]) => k === "crd:ttl-check");
  assert.ok(entry, "entry should be in the snapshot");
  // Third element is an absolute epoch ms, not a remaining duration.
  assert.ok(entry[2] > Date.now(), "expiry must be a future absolute timestamp");
  assert.ok(entry[2] < Date.now() + 8 * 24 * 60 * 60 * 1000, "should still be within the 7-day TTL");
  await fs.rm(file, { force: true });
});

test("a snapshot from an older schema version is discarded, not restored", async () => {
  // Regression guard for a real incident: persistence resurrected pre-change profiles after
  // a deploy, so the fix looked like it had not shipped.
  const file = tmpFile();
  const stale = {
    version: 1,
    schemaVersion: 1, // older than SCHEMA_VERSION
    savedAt: new Date().toISOString(),
    caches: [{ name: "profile", entries: [["crd:v1:123", { name: "OLD SHAPE" }, Date.now() + 60_000]] }],
  };
  await fs.writeFile(file, JSON.stringify(stale), "utf8");
  const result = await loadSnapshot(file);
  assert.equal(result.restored, 0);
  assert.match(result.error, /schemaVersion/);
  await fs.rm(file, { force: true });
});

test("snapshots stamp the current schema version so the next boot can check it", async () => {
  const file = tmpFile();
  branchGeoCache.set("zip:11111", { lat: 1, lng: 2 });
  await saveSnapshot(file);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(raw.schemaVersion, SCHEMA_VERSION);
  await fs.rm(file, { force: true });
});
