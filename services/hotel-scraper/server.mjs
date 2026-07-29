// Lightweight control/observability API for the hotel crawler. The 24/7 crawl
// runs in worker.mjs (its own systemd unit); this server just exposes health,
// live progress, and a manual one-ZIP kick. Bind to loopback on the VM — nothing
// external calls it (reach /status and /run via an SSH/IAP tunnel).

import http from "node:http";
import { config } from "./scripts/lib/config.mjs";
import { getProgress, claimNextZip, markZipDone, markZipError, ping, closePool } from "./scripts/lib/db.mjs";
import { processZip } from "./scripts/lib/pipeline.mjs";

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
        service: "hotel-scraper",
        db,
        timestamp: new Date().toISOString(),
      });
    }

    // Live progress snapshot (done/left/hotels/cost).
    if (request.method === "GET" && requestUrl.pathname === "/status") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const progress = await getProgress();
      return sendJson(response, 200, { ok: true, service: "hotel-scraper", progress });
    }

    // Manual kick: claim + enrich the next pending ZIP (or a specific one). Useful
    // for debugging when the worker unit is stopped; the worker owns steady state.
    if (request.method === "POST" && requestUrl.pathname === "/run") {
      if (!isAuthorized(request)) return sendJson(response, 401, { ok: false, error: "Unauthorized" });
      const body = await readJson(request);
      const limit = Math.max(1, Math.min(20, Number(body?.limit) || 1));
      const results = [];
      for (let i = 0; i < limit; i++) {
        const zipRow = await claimNextZip();
        if (!zipRow) break;
        try {
          const r = await processZip(zipRow);
          await markZipDone(zipRow.zip, { placesCalls: r.placesCalls, hotelsFound: r.hotelsFound });
          results.push({ zip: zipRow.zip, ok: true, ...r });
        } catch (err) {
          await markZipError(zipRow.zip, err.message).catch(() => {});
          results.push({ zip: zipRow.zip, ok: false, error: err.message });
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
  console.log(JSON.stringify({ event: "server.started", service: "hotel-scraper", port }));
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
