// Lightweight control/observability API for the RIA directory. The 24/7 ingest
// loop runs in worker.mjs (its own systemd unit); this server just exposes health,
// live progress, and a manual ingest kick. Bind to loopback on the VM — nothing
// external calls it (reach /status and /run via an SSH/IAP tunnel).

import http from "node:http";
import { config } from "./scripts/lib/config.mjs";
import { getProgress, ping, closePool } from "./scripts/lib/db.mjs";
import { runIngestCycle } from "./scripts/lib/pipeline.mjs";

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
        service: "ria-directory",
        db,
        timestamp: new Date().toISOString(),
      });
    }

    // Live progress snapshot (firms/advisers/states/AUM/ZIP coverage/freshness).
    if (request.method === "GET" && requestUrl.pathname === "/status") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const progress = await getProgress();
      return sendJson(response, 200, { ok: true, service: "ria-directory", progress });
    }

    // Manual kick: run an ingest cycle now (discover → download → ingest the latest
    // compilation, or ingest explicit local files). Useful for debugging when the
    // worker unit is stopped; the worker owns steady state.
    //   body: { force?: bool, firmsFile?: path, individualsFile?: path }
    if (request.method === "POST" && requestUrl.pathname === "/run") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const body = await readJson(request);
      const outcome = await runIngestCycle({
        force: !!body?.force,
        firmsFile: body?.firmsFile || null,
        individualsFile: body?.individualsFile || null,
      });
      return sendJson(response, 200, { ok: true, ...outcome });
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
  console.log(JSON.stringify({ event: "server.started", service: "ria-directory", port }));
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
