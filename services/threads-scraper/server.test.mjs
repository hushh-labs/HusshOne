import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("auth-protected endpoints reject missing or wrong bearer tokens", async () => {
  const port = 18_080 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, PORT: String(port), SCRAPER_API_KEY: "test-secret", OUTPUT_DIR: "/tmp/threads-scraper-test-outputs" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth(port);
    const missing = await fetch(`http://127.0.0.1:${port}/session/status`);
    assert.equal(missing.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/session/status`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`http://127.0.0.1:${port}/session/status`, { headers: { Authorization: "Bearer test-secret" } });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.service, "threads-scraper");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("server did not become healthy");
}
