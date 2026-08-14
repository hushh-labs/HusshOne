import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { floridaMeta, resetFlorida } from "./florida-store.mjs";

test("Florida meta binds to the SHA-256 of the exact served artifact bytes", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "florida-store-test-"));
  const artifact = Buffer.from(
    '{"meta":{"builtAt":"2026-08-11T18:46:24.202Z","formYear":2025,"partial":true},"people":[]}\n',
  );
  try {
    fs.writeFileSync(path.join(dataDir, "florida-net-worth.json"), artifact);
    resetFlorida();
    const meta = floridaMeta(dataDir);
    assert.equal(
      meta.sourceArtifactSha256,
      createHash("sha256").update(artifact).digest("hex"),
    );
    assert.equal(meta.built, true);
    assert.equal(meta.sourceSnapshotId, "florida-form6-2025-20260811T184624Z-partial");
    assert.equal(meta.sourceRetrievedAt, "2026-08-11T18:46:24.202Z");
    assert.match(meta.note, /not retained or emitted/);
    assert.doesNotMatch(meta.note, /never read or stored/);
  } finally {
    resetFlorida();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
