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

test("legacy API key remains the fallback for both route scopes", () => {
  const legacy = "l".repeat(32);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import('./scripts/lib/config.mjs').then(({config}) => "
        + "console.log(JSON.stringify([config.professionalApiKey, config.form6ApiKey])))",
    ],
    {
      cwd: serviceRoot,
      env: {
        ...process.env,
        INSIDER_API_KEY: legacy,
        INSIDER_PROFESSIONAL_API_KEY: "",
        INSIDER_FORM6_API_KEY: "",
      },
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout.trim()), [legacy, legacy]);
});

test("route-scoped API keys stay separate", () => {
  const professional = "p".repeat(32);
  const form6 = "f".repeat(32);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import('./scripts/lib/config.mjs').then(({config}) => "
        + "console.log(JSON.stringify([config.professionalApiKey, config.form6ApiKey])))",
    ],
    {
      cwd: serviceRoot,
      env: {
        ...process.env,
        INSIDER_API_KEY: "",
        INSIDER_PROFESSIONAL_API_KEY: professional,
        INSIDER_FORM6_API_KEY: form6,
      },
      encoding: "utf8",
    },
  );

  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout.trim()), [professional, form6]);
});

test("production refuses an incomplete route-scoped key pair", () => {
  const child = spawnSync(process.execPath, ["server.mjs"], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      INSIDER_REQUIRE_API_KEY: "true",
      INSIDER_API_KEY: "l".repeat(32),
      INSIDER_PROFESSIONAL_API_KEY: "p".repeat(32),
      INSIDER_FORM6_API_KEY: "",
    },
    encoding: "utf8",
  });

  assert.notEqual(child.status, 0);
  assert.match(
    `${child.stdout}\n${child.stderr}`,
    /must both be set when route-scoped authentication is configured/,
  );
});

test("production refuses equal route-scoped key values", () => {
  const shared = "s".repeat(32);
  const child = spawnSync(process.execPath, ["server.mjs"], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      INSIDER_REQUIRE_API_KEY: "true",
      INSIDER_API_KEY: "",
      INSIDER_PROFESSIONAL_API_KEY: shared,
      INSIDER_FORM6_API_KEY: shared,
    },
    encoding: "utf8",
  });

  assert.notEqual(child.status, 0);
  assert.match(
    `${child.stdout}\n${child.stderr}`,
    /must contain distinct values/,
  );
});
