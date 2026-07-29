#!/usr/bin/env bash
# Manual triggers for the social-circles-directory VM.
#   run-now.sh report        # send the combined daily roll-up email right now (default)
#   run-now.sh rebuild       # run one full graph rebuild pass now via the API
# All actions run on the VM over SSH; the loopback API key is read on the VM.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-social-circles-directory-vm}"

ACTION="${1:-report}"

case "$ACTION" in
  report)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
      set -e
      sudo systemctl start social-circles-directory-report.service
      sleep 2
      sudo journalctl -u social-circles-directory-report.service -n 40 --no-pager
    '
    ;;
  rebuild)
    gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
      set -e
      KEY="$(sudo grep -E "^SCRAPER_API_KEY=" /etc/social-circles-directory.env | cut -d= -f2-)"
      curl -fsS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
        -d "{}" http://127.0.0.1:8080/run | jq . \
        || curl -fsS -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
        -d "{}" http://127.0.0.1:8080/run
    '
    ;;
  *)
    echo "Usage: run-now.sh [report|rebuild]" >&2
    exit 1
    ;;
esac
