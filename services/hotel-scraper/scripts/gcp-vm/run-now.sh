#!/usr/bin/env bash
# Manual triggers for the hotel-scraper VM.
#   run-now.sh report        # send the daily progress email right now (default)
#   run-now.sh zip [N]       # process N pending ZIPs now via the API (default 1, max 20)
#   run-now.sh osm           # (re)run the OSM bulk load in the background
# All actions run on the VM over SSH; the loopback API key is read on the VM.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-hotel-scraper-vm}"

ACTION="${1:-report}"
ARG2="${2:-}"

case "$ACTION" in
  report)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
      set -e
      sudo systemctl start hotel-scraper-report.service
      sleep 2
      sudo journalctl -u hotel-scraper-report.service -n 40 --no-pager
    '
    ;;
  zip)
    LIMIT="${ARG2:-1}"
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
      set -e
      KEY=\"\$(sudo grep -E '^SCRAPER_API_KEY=' /etc/hotel-scraper.env | cut -d= -f2-)\"
      curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"limit\": ${LIMIT}}' http://127.0.0.1:8080/run | jq . \
        || curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"limit\": ${LIMIT}}' http://127.0.0.1:8080/run
    "
    ;;
  osm)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
      set -e
      sudo systemctl start --no-block hotel-scraper-osm.service
      echo "OSM bulk load started in background. Follow with:"
      echo "  gcloud compute ssh '"$VM_NAME"' --zone '"$ZONE"' --command \"sudo journalctl -u hotel-scraper-osm -f\""
    '
    ;;
  *)
    echo "Usage: run-now.sh [report|zip N|osm]" >&2
    exit 1
    ;;
esac
