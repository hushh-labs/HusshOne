#!/usr/bin/env bash
# Smoke the deployed BrokerCheck Advisor API. Unlike the rest of the fleet this endpoint
# is PUBLIC, so the checks run from here over the internet — no SSH hop needed. The unit
# state check at the end does use SSH.
set -euo pipefail

PROJECT="${PROJECT:-hushh-tech-prod}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-brokercheck-api-vm}"

STATIC_IP="${STATIC_IP:-$(gcloud compute addresses describe brokercheck-api-ip --project "$PROJECT" --region "${ZONE%-*}" --format='value(address)' 2>/dev/null || true)}"
if [[ -z "$STATIC_IP" ]]; then
  echo "Could not resolve the static IP. Is the VM deployed?" >&2
  exit 1
fi
BASE="${BASE:-https://brokercheck.${STATIC_IP}.sslip.io}"
LAT="${LAT:-47.6769}"
LNG="${LNG:--122.2060}"

# /v1/* is bearer-gated; /health is not. The key is read from Secret Manager and never printed.
KEY="${BROKERCHECK_API_KEY:-$(gcloud secrets versions access latest --secret=brokercheck-api-key --project "$PROJECT" 2>/dev/null || true)}"
AUTH=()
[[ -n "$KEY" ]] && AUTH=(-H "Authorization: Bearer $KEY")

echo "== $BASE =="
echo "-- /health (open, no auth) --"
curl -fsS -m 20 "$BASE/health" | jq . 2>/dev/null || curl -fsS -m 20 "$BASE/health"

echo
echo "-- auth gate: /v1/advisors WITHOUT a key should be 401 --"
echo "   got HTTP $(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/v1/advisors?lat=$LAT&lng=$LNG&limit=1")"

echo
echo "-- /v1/advisors (lat=$LAT lng=$LNG, 5 results, no detail) --"
# NOTE: %-formatting, not f-strings. An f-string expression cannot contain a backslash,
# and every dict key here would need one once this is embedded in a shell-quoted -c.
curl -fsS -N -m 120 "${AUTH[@]}" "$BASE/v1/advisors?lat=$LAT&lng=$LNG&radiusMi=10&limit=5&detail=false&batchSize=5" \
  | python3 -c '
import json, sys
for line in sys.stdin:
    f = json.loads(line)
    t = f["type"]
    if t == "meta":
        print("  meta: total=%s ranked=%s radius=%smi (requested %s, adjusted=%s) grouped=%s cache=%s" % (
            f["estimatedTotal"], f["ranked"], f["radiusMi"],
            f["radiusRequested"], f["radiusAdjusted"], f["grouped"], f["cache"]))
    elif t in ("batch", "branches"):
        for i in f["items"]:
            name = i.get("name") or i.get("firmName") or "?"
            firm = (i.get("firm") or {}).get("firmName") or i.get("city") or ""
            print("    %-32s %-28s %sm  %s" % (
                name[:30], firm[:26], i.get("distanceMeters"), i.get("geoPrecision")))
    elif t == "done":
        print("  done in %sms  mode=%s" % (f["ms"], f["mode"]))
    elif t == "error":
        print("  ERROR: %s" % f["error"])
        sys.exit(1)
'

echo
echo "-- /v1/stats (cache hit rates) --"
curl -fsS -m 20 "${AUTH[@]}" "$BASE/v1/stats" | jq -c '.caches[]' 2>/dev/null || curl -fsS -m 20 "${AUTH[@]}" "$BASE/v1/stats"

echo
echo "-- units --"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command 'sudo systemctl is-active brokercheck-api caddy || true'
