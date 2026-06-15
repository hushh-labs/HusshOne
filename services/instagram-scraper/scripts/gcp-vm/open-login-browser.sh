#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-instagram-scraper-vm}"

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is required. Set PROJECT or gcloud config set project <id>." >&2
  exit 1
fi

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command \
  "sudo systemctl stop instagram-scraper-api; sudo systemctl restart instagram-login-browser; sudo systemctl start instagram-scraper-api; sudo systemctl status --no-pager instagram-login-browser | tail -20"

cat <<EOF

Instagram login browser is open inside the VM display.

In another terminal, keep this tunnel running:

  gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE -- -N -L 6080:localhost:6080 -L 8080:localhost:8080

Then open the login intent page:

  http://127.0.0.1:8080/login-intent

Or open noVNC directly:

  http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080

After Instagram login is done, leave the Chrome window open and retry /scrape.

EOF
