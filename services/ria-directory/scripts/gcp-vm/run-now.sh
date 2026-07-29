#!/usr/bin/env bash
# Manual triggers for the ria-directory VM.
#   run-now.sh report        # send the daily progress email right now (default)
#   run-now.sh ingest        # run an ingest cycle now via the API (discover + ingest latest)
#   run-now.sh ingest force  # force re-ingest the latest compilation even if current
# All actions run on the VM over SSH; the loopback API key is read on the VM.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-ria-directory-vm}"

ACTION="${1:-report}"
ARG2="${2:-}"

case "$ACTION" in
  report)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
      set -e
      sudo systemctl start ria-directory-report.service
      sleep 2
      sudo journalctl -u ria-directory-report.service -n 40 --no-pager
    '
    ;;
  ingest)
    FORCE="false"
    if [[ "$ARG2" == "force" ]]; then FORCE="true"; fi
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
      set -e
      KEY=\"\$(sudo grep -E '^SCRAPER_API_KEY=' /etc/ria-directory.env | cut -d= -f2-)\"
      curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"force\": ${FORCE}}' http://127.0.0.1:8080/run | jq . \
        || curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"force\": ${FORCE}}' http://127.0.0.1:8080/run
    "
    ;;
  *)
    echo "Usage: run-now.sh [report|ingest [force]]" >&2
    exit 1
    ;;
esac
