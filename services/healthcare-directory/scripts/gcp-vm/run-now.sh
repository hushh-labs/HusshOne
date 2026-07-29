#!/usr/bin/env bash
# Manual triggers for the healthcare-directory VM.
#   run-now.sh report        # send the daily progress email right now (default)
#   run-now.sh refresh       # trigger an NPPES refresh cycle now via the loopback API
#   run-now.sh worker        # restart the 24/7 ingest worker (e.g. after a config change)
# All actions run on the VM over SSH; the loopback API key is read on the VM.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-healthcare-directory-vm}"

ACTION="${1:-report}"

case "$ACTION" in
  report)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
      set -e
      sudo systemctl start healthcare-directory-report.service
      sleep 2
      sudo journalctl -u healthcare-directory-report.service -n 40 --no-pager
    '
    ;;
  refresh)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
      set -e
      KEY=\"\$(sudo grep -E '^SCRAPER_API_KEY=' /etc/healthcare-directory.env | cut -d= -f2-)\"
      curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{}' http://127.0.0.1:8080/run | jq . \
        || curl -fsS -X POST -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{}' http://127.0.0.1:8080/run
    "
    ;;
  worker)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
      set -e
      sudo systemctl restart healthcare-directory-worker.service
      sleep 2
      sudo systemctl status healthcare-directory-worker.service --no-pager | head -n 20
    '
    ;;
  *)
    echo "Usage: run-now.sh [report|refresh|worker]" >&2
    exit 1
    ;;
esac
