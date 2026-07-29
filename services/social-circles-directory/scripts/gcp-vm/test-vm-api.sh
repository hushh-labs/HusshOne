#!/usr/bin/env bash
# Health + graph-stats check for the social-circles-directory VM.
# The API binds to 127.0.0.1 (no public firewall), so we curl it from INSIDE the
# VM over SSH. /health is open; /status needs the Bearer key, which lives in the
# VM's env file — we read it there, it is never printed locally.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-social-circles-directory-vm}"

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command '
  set -e
  echo "== /health =="
  curl -fsS http://127.0.0.1:8080/health | jq . || curl -fsS http://127.0.0.1:8080/health
  echo
  echo "== /status =="
  KEY="$(sudo grep -E "^SCRAPER_API_KEY=" /etc/social-circles-directory.env | cut -d= -f2-)"
  curl -fsS -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/status | jq . \
    || curl -fsS -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/status
  echo
  echo "== units =="
  sudo systemctl is-active cloud-sql-proxy social-circles-directory-worker social-circles-directory-api social-circles-directory-report.timer || true
'
