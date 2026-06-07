#!/usr/bin/env bash
# Reproducible apply of one.hushh.ai observability resources.
# Idempotent-ish: "create" calls fail harmlessly if the resource already exists.
set -uo pipefail

PROJECT="${PROJECT:-hushone-app}"
REGION="${REGION:-us-central1}"
SA="${SA:-53407187172-compute@developer.gserviceaccount.com}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-ankit@hushh.ai}"
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
cd "$(dirname "$0")"

echo "==> Enable APIs"
gcloud services enable cloudtrace.googleapis.com monitoring.googleapis.com \
  logging.googleapis.com clouderrorreporting.googleapis.com --project="$PROJECT"

echo "==> IAM: trace writer for runtime SA"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/cloudtrace.agent" --condition=None >/dev/null

echo "==> Log-based metrics"
for m in metrics/*.json; do
  name="$(basename "$m" .json)"
  gcloud logging metrics create "$name" --config-from-file="$m" --project="$PROJECT" \
    || gcloud logging metrics update "$name" --config-from-file="$m" --project="$PROJECT"
done

echo "==> Notification channel (email)"
gcloud beta monitoring channels create --type=email \
  --display-name="One SRE Email (${NOTIFY_EMAIL%%@*})" \
  --channel-labels=email_address="$NOTIFY_EMAIL" --project="$PROJECT" || true

echo "==> Uptime checks"
gcloud monitoring uptime create "one.hushh.ai availability" --resource-type=uptime-url \
  --resource-labels=host=one.hushh.ai,project_id="$PROJECT" --protocol=https --path="/" --period=5 --timeout=10 --project="$PROJECT" || true
gcloud monitoring uptime create "hushh-ria-intelligence-api health" --resource-type=uptime-url \
  --resource-labels=host=hushh-ria-intelligence-api-53407187172.us-central1.run.app,project_id="$PROJECT" --protocol=https --path="/health" --period=5 --timeout=10 --project="$PROJECT" || true

echo "==> Alert policies (set CHANNEL to your notification channel id first if re-creating)"
for a in alerts/*.json; do
  gcloud beta monitoring policies create --policy-from-file="$a" --project="$PROJECT" || true
done

echo "==> Dashboard"
gcloud monitoring dashboards create --config-from-file=dashboards/one_e2e_dashboard.json --project="$PROJECT" || true

echo "==> Log Analytics + BigQuery link"
gcloud logging buckets update _Default --location=global --enable-analytics --project="$PROJECT" || true
gcloud logging links create one_logs --bucket=_Default --location=global --project="$PROJECT" || true

echo "Done. Alert policies reference notification channel by id — edit alerts/*.json if the channel changes."
