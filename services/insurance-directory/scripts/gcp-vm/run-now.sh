#!/usr/bin/env bash
# Manual triggers for the insurance-directory VM.
#   run-now.sh report          # send the daily progress email right now (default)
#   run-now.sh run [N]         # claim + collect up to N workable states now (default 1)
#   run-now.sh state CODE      # force-collect one state now, e.g. `run-now.sh state TX`
# All actions run on the VM over SSH; the loopback API key is read on the VM.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-insurance-directory-vm}"

ACTION="${1:-report}"
ARG2="${2:-}"

case "$ACTION" in
  report)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
      set -e
      sudo systemctl start insurance-directory-report.service
      sleep 2
      sudo journalctl -u insurance-directory-report.service -n 40 --no-pager
    '
    ;;
  run)
    LIMIT="${ARG2:-1}"
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
      set -e
      KEY=\"\$(sudo grep -E '^SCRAPER_API_KEY=' /etc/insurance-directory.env | cut -d= -f2-)\"
      curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"limit\": ${LIMIT}}' http://127.0.0.1:8080/run | jq . \
        || curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"limit\": ${LIMIT}}' http://127.0.0.1:8080/run
    "
    ;;
  state)
    STATE="${ARG2:-}"
    if [[ -z "$STATE" ]]; then
      echo "Usage: run-now.sh state CODE   (e.g. run-now.sh state TX)" >&2
      exit 1
    fi
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
      set -e
      KEY=\"\$(sudo grep -E '^SCRAPER_API_KEY=' /etc/insurance-directory.env | cut -d= -f2-)\"
      curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"state\": \"${STATE}\"}' http://127.0.0.1:8080/run | jq . \
        || curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"state\": \"${STATE}\"}' http://127.0.0.1:8080/run
    "
    ;;
  *)
    echo "Usage: run-now.sh [report|run N|state CODE]" >&2
    exit 1
    ;;
esac
