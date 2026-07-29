// Lightweight control/observability API for the insurance directory. The 24/7
// collection runs in worker.mjs (its own systemd unit); this server just exposes
// health, live progress, and a manual per-state kick. Bind to loopback on the VM —
// nothing external calls it (reach /status and /run via an SSH/IAP tunnel).

import http from "node:http";
import { config } from "./scripts/lib/config.mjs";
import {
  getProgress,
  claimNextState,
  markStateRunning,
  markStateDone,
  markStateError,
  markStateBlocked,
  ping,
  closePool,
} from "./scripts/lib/db.mjs";
import { selectedAdapters, getAdapter } from "./scripts/lib/adapters/index.mjs";
import { runStateAdapter } from "./scripts/lib/pipeline.mjs";

const port = config.port;
const apiKey = config.apiKey;
const log = (o) => console.log(JSON.stringify(o));

// Collect one state (claimed or explicitly named), run its adapter, stamp progress.
async function collectState(stateRow) {
  const adapter = getAdapter(stateRow.state);
  if (!adapter) {
    await markStateError(stateRow.state, `No adapter registered for ${stateRow.state}`).catch(() => {});
    return { state: stateRow.state, ok: false, error: "no adapter" };
  }
  try {
    const r = await runStateAdapter(adapter, { log });
    if (r.blocked) await markStateBlocked(stateRow.state, r.note);
    else await markStateDone(stateRow.state, { producersUpserted: r.upserted });
    return { state: stateRow.state, ok: true, ...r };
  } catch (err) {
    await markStateError(stateRow.state, err.message).catch(() => {});
    return { state: stateRow.state, ok: false, error: err.message };
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");

    // Open health check (used by the post-deploy gate + uptime probes).
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      let db = false;
      try {
        db = await ping();
      } catch {
        db = false;
      }
      return sendJson(response, db ? 200 : 503, {
        ok: db,
        service: "insurance-directory",
        db,
        timestamp: new Date().toISOString(),
      });
    }

    // Live progress snapshot (producers, per-state status, blocked states).
    if (request.method === "GET" && requestUrl.pathname === "/status") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const progress = await getProgress();
      return sendJson(response, 200, { ok: true, service: "insurance-directory", progress });
    }

    // Manual kick: collect the next claimable state(s), or a specific {state:"TX"}.
    // Useful for debugging when the worker unit is stopped; the worker owns steady state.
    if (request.method === "POST" && requestUrl.pathname === "/run") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const body = await readJson(request);
      const results = [];

      if (body?.state) {
        const code = String(body.state).trim().toUpperCase();
        const adapter = getAdapter(code);
        if (!adapter) return sendJson(response, 400, { ok: false, error: `No adapter for ${code}` });
        const row = await markStateRunning(code, adapter.kind);
        results.push(await collectState(row));
      } else {
        const { adapters } = selectedAdapters(config.states);
        const workable = adapters.filter((a) => a.kind !== "blocked").map((a) => a.code);
        const limit = Math.max(1, Math.min(56, Number(body?.limit) || 1));
        for (let i = 0; i < limit; i++) {
          const row = await claimNextState({ states: workable });
          if (!row) break;
          results.push(await collectState(row));
        }
      }
      return sendJson(response, 200, { ok: true, processed: results.length, results });
    }

    return sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      type: error?.name || "Error",
    });
  }
});

server.listen(port, () => {
  log({ event: "server.started", service: "insurance-directory", port });
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(async () => {
      await closePool().catch(() => {});
      process.exit(0);
    });
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function isAuthorized(request) {
  if (!apiKey) return true;
  const header = String(request.headers.authorization || "");
  return header === `Bearer ${apiKey}`;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
