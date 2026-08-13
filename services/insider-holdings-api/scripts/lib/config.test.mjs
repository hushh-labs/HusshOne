import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const serviceRoot = new URL("../../", import.meta.url);

test("production refuses to start without a strong API key", () => {
  const child = spawnSync(process.execPath, ["server.mjs"], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      INSIDER_REQUIRE_API_KEY: "true",
      INSIDER_API_KEY: "",
    },
    encoding: "utf8",
  });

  assert.notEqual(child.status, 0);
  assert.match(
    `${child.stdout}\n${child.stderr}`,
    /INSIDER_API_KEY must be at least 32 characters/,
  );
});
