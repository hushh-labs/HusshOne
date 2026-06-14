#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-linkedin-scraper-vm}"

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is required. Set PROJECT or gcloud config set project <id>." >&2
  exit 1
fi

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command \
  "sudo systemctl stop linkedin-scraper-api; sudo systemctl restart linkedin-login-browser; sudo systemctl status --no-pager linkedin-login-browser | tail -20"

cat <<EOF

LinkedIn login browser is open inside the VM display.

In another terminal, keep this tunnel running:

  gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE -- -N -L 6080:localhost:6080

Then open:

  http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080

After LinkedIn login is done, leave the Chrome window open and run:

  gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE --command "sudo systemctl start linkedin-scraper-api"
EOF
