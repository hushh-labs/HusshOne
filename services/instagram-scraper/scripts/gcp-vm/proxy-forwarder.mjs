#!/usr/bin/env node
/*
 * Local egress forwarder for the scraper's Chrome.
 *
 * Instagram/X/Threads 429-block the VM's datacenter IP. The login Chrome's `--proxy-server` points at this
 * forwarder (127.0.0.1:8000); we forward ALL outbound traffic to the upstream residential/mobile proxy in
 * SCRAPER_PROXY_URL. proxy-chain authenticates the upstream from the URL itself — works for both
 * credentialed (`http://user:pass@gateway:port`, incl. sticky-session usernames) and IP-whitelist
 * (`http://gateway:port`) providers, so this is provider-agnostic.
 *
 * SAFE BY DEFAULT: if SCRAPER_PROXY_URL is unset/empty, the forwarder exits 0 (systemd leaves it inactive)
 * and the Chrome launch wrapper omits `--proxy-server` — egress stays direct, i.e. exactly today's behavior.
 * Activation = set the SCRAPER_PROXY_URL secret + redeploy. Credentials are never logged.
 */
import { Server } from "proxy-chain";

const upstream = (process.env.SCRAPER_PROXY_URL || "").trim();
const port = Number(process.env.SCRAPER_PROXY_LISTEN_PORT || 8000);

if (!upstream) {
  console.log(JSON.stringify({ event: "scraper.proxy.disabled", reason: "SCRAPER_PROXY_URL unset" }));
  process.exit(0);
}

let upstreamHost = "upstream";
try {
  upstreamHost = new URL(upstream).host; // host only — never the credentials
} catch {
  console.error(JSON.stringify({ event: "scraper.proxy.bad_url" }));
  process.exit(1);
}

const server = new Server({
  port,
  host: "127.0.0.1",
  // One upstream for every request. Rotation = restart this service (sticky-per-session): the upstream
  // session id (when the provider encodes it in the username) then changes with the new SCRAPER_PROXY_URL.
  prepareRequestFunction: () => ({ upstreamProxyUrl: upstream }),
});

server.listen(() => {
  console.log(JSON.stringify({ event: "scraper.proxy.listening", port, upstreamHost }));
});

server.on("requestFailed", ({ error }) => {
  console.error(JSON.stringify({ event: "scraper.proxy.request_failed", message: error?.message || String(error) }));
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(true, () => process.exit(0)));
}
