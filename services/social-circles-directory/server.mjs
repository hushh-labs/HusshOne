// Lightweight control/observability API for the social-circles graph builder. The
// 24/7 rebuild loop runs in worker.mjs (its own systemd unit); this server exposes
// health, live graph stats, and a manual rebuild kick. Binds to loopback on the VM
// — nothing external calls it (reach /status and /run via an SSH/IAP tunnel).
//
//   GET  /health   open   — DB reachability (used by deploy gate + uptime probes)
//   GET  /status   Bearer — graph stats (nodes/edges by type, last build)
//   POST /run      Bearer — trigger one full rebuild pass (idempotent)

import http from "node:http";
import { config } from "./scripts/lib/config.mjs";
import { getGraphStats, ping, closePool } from "./scripts/lib/db.mjs";
import { runBuildPass } from "./scripts/lib/build.mjs";

const port = config.port;
const apiKey = config.apiKey;

// A rebuild pass is heavy; serialize manual kicks so overlapping POST /run calls
// don't pile up. (Passes are idempotent, so an accidental overlap with the worker
// is harmless — this just avoids wasted concurrent work from the API side.)
let runInFlight = null;

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      let db = false;
      try {
        db = await ping();
      } catch {
        db = false;
      }
      return sendJson(response, db ? 200 : 503, {
        ok: db,
        service: "social-circles-directory",
        db,
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method === "GET" && requestUrl.pathname === "/status") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const stats = await getGraphStats();
      return sendJson(response, 200, { ok: true, service: "social-circles-directory", stats });
    }

    // Manual kick: run one full rebuild pass now. Useful for debugging when the
    // worker unit is stopped; the worker owns steady state.
    if (request.method === "POST" && requestUrl.pathname === "/run") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      if (runInFlight) return sendJson(response, 409, { ok: false, error: "A rebuild is already running" });
      runInFlight = runBuildPass().finally(() => {
        runInFlight = null;
      });
      try {
        const summary = await runInFlight;
        return sendJson(response, 200, { ok: true, summary });
      } catch (err) {
        return sendJson(response, 500, { ok: false, error: err.message });
      }
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
  console.log(JSON.stringify({ event: "server.started", service: "social-circles-directory", port }));
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(async () => {
      await closePool().catch(() => {});
      process.exit(0);
    });
  });
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
