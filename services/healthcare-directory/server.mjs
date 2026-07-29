// Lightweight control/observability API for the healthcare directory. The 24/7
// ingest runs in worker.mjs (its own systemd unit); this server just exposes health,
// live progress, and a manual refresh kick. Bind to loopback on the VM — nothing
// external calls it (reach /status and /run via an SSH/IAP tunnel).

import http from "node:http";
import { config } from "./scripts/lib/config.mjs";
import { getProgress, ping, closePool } from "./scripts/lib/db.mjs";
import { runRefreshCycle } from "./scripts/lib/pipeline.mjs";

const port = config.port;
const apiKey = config.apiKey;

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
        service: "healthcare-directory",
        db,
        timestamp: new Date().toISOString(),
      });
    }

    // Live progress snapshot (providers/states/ZIP coverage/last ingest).
    if (request.method === "GET" && requestUrl.pathname === "/status") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const progress = await getProgress();
      return sendJson(response, 200, { ok: true, service: "healthcare-directory", progress });
    }

    // Manual kick: run one refresh pass (discover newest monthly/weekly, ingest any
    // not yet applied). Useful for debugging when the worker unit is stopped; the
    // worker owns steady state. Heavy — this can download + stream a bulk file.
    if (request.method === "POST" && requestUrl.pathname === "/run") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const result = await runRefreshCycle();
      return sendJson(response, 200, {
        ok: true,
        monthly: result.monthly?.filename || null,
        weekly: result.weekly?.filename || null,
        ingested: result.ingested,
      });
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
  console.log(JSON.stringify({ event: "server.started", service: "healthcare-directory", port }));
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
