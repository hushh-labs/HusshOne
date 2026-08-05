#!/usr/bin/env bash
# Smoke the deployed Insurance Agents API from the public internet.
set -euo pipefail

PROJECT="${PROJECT:-hushh-tech-prod}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-insurance-agents-vm}"

STATIC_IP="${STATIC_IP:-$(gcloud compute addresses describe insurance-agents-ip --project "$PROJECT" --region "${ZONE%-*}" --format='value(address)' 2>/dev/null || true)}"
[[ -z "$STATIC_IP" ]] && { echo "Could not resolve static IP. Deployed?" >&2; exit 1; }
BASE="${BASE:-https://insurance-agents.${STATIC_IP}.sslip.io}"
LAT="${LAT:-47.6769}"; LNG="${LNG:--122.2060}"

KEY="${INSURANCE_AGENTS_API_KEY:-$(gcloud secrets versions access latest --secret=insurance-agents-api-key --project "$PROJECT" 2>/dev/null || true)}"
AUTH=(); [[ -n "$KEY" ]] && AUTH=(-H "Authorization: Bearer $KEY")

echo "== $BASE =="
echo "-- /health --"
curl -fsS -m 20 "$BASE/health" | jq . 2>/dev/null || curl -fsS -m 20 "$BASE/health"

echo
echo "-- auth gate: /v1/agents WITHOUT a key should be 401 --"
echo "   got HTTP $(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/v1/agents?lat=$LAT&lng=$LNG&limit=1")"

echo
echo "-- /v1/agents (lat=$LAT lng=$LNG, 5 agencies) --"
curl -fsS -N -m 60 "${AUTH[@]}" "$BASE/v1/agents?lat=$LAT&lng=$LNG&radiusMi=25&limit=5&batchSize=5" | python3 -c '
import json, sys
for line in sys.stdin:
    f = json.loads(line); t = f["type"]
    if t == "meta":
        print("  meta: estimatedTotal=%s available=%s radius=%smi pages=%s cache=%s" % (
            f["estimatedTotal"], f["available"], f["radiusMi"], f.get("pagesFetched"), f["cache"]))
    elif t == "batch":
        for a in f["items"]:
            print("    %-40s %-30s %smi  %s" % (
                (a.get("name") or "")[:40], (a.get("address") or {}).get("formatted","")[:30],
                a.get("distanceMiles"), a.get("phone") or ""))
    elif t == "done":
        print("  done in %sms  returned=%s hasMore=%s" % (f["ms"], f["returned"], f["hasMore"]))
    elif t == "error":
        print("  ERROR: %s" % f["error"]); sys.exit(1)
'

echo
echo "-- units --"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command 'sudo systemctl is-active insurance-agents-api caddy || true'
