#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-linkedin-scraper-vm}"
API_KEY_FILE="${API_KEY_FILE:-$PWD/secrets/vm-api-key}"
SECRET_NAME="${SECRET_NAME:-linkedin-scraper-api-key}"
PROFILE_URL="${1:-https://www.linkedin.com/in/ankit-kumar-886428288/}"

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is required. Set PROJECT or gcloud config set project <id>." >&2
  exit 1
fi

EXTERNAL_IP="$(gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
if [[ -s "$API_KEY_FILE" ]]; then
  API_KEY="$(tr -d '\n' < "$API_KEY_FILE")"
else
  API_KEY="$(gcloud secrets versions access latest --secret "$SECRET_NAME" --project "$PROJECT" 2>/dev/null || true)"
fi

if [[ -z "${API_KEY:-}" ]]; then
  echo "Missing API key. Expected $API_KEY_FILE or Secret Manager secret: $SECRET_NAME" >&2
  exit 1
fi

curl -sS \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$PROFILE_URL\"}" \
  "http://$EXTERNAL_IP:8080/scrape"
