#!/usr/bin/env bash
# Launch the persistent login Chrome for the Instagram scraper.
#
# If SCRAPER_PROXY_URL is set, route all Chrome egress through the local proxy-chain forwarder
# (127.0.0.1:8000) so Instagram sees a residential/mobile IP instead of the VM's 429-blocked datacenter IP.
# If it is unset, launch WITHOUT --proxy-server — identical to the previous inline ExecStart (safe default).
set -euo pipefail

PROXY_ARGS=()
if [ -n "${SCRAPER_PROXY_URL:-}" ]; then
  PORT="${SCRAPER_PROXY_LISTEN_PORT:-8000}"
  PROXY_ARGS=(--proxy-server="http://127.0.0.1:${PORT}" --proxy-bypass-list="127.0.0.1,localhost,[::1]")
fi

exec /usr/bin/chromium \
  --user-data-dir=/var/lib/instagram-scraper/chrome-profile \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled --start-maximized \
  "${PROXY_ARGS[@]}" \
  https://www.instagram.com/
