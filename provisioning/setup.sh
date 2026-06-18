#!/usr/bin/env bash
# One Burst Compute — BYOC provisioning (gcloud).
#
# Sets up everything One needs to burst into YOUR Google Cloud project:
#   - enables the APIs (Compute, Cloud TPU, Cloud Storage)
#   - creates a least-privilege custom role + a dedicated service account
#   - (optionally) a GCS bucket for TPU results
#   - (optionally) a service-account key to paste into One
#
# Safe to re-run (idempotent). Works for a human at a terminal OR an automation system.
#
# Usage:
#   PROJECT_ID=my-project REGION=us-central1 ./setup.sh
# Options (env vars):
#   CREATE_KEY=true            also create a JSON key (one-burst-key.json) for One
#   ENABLE_TPU=true            also provision the TPU result bucket + grant storage access
#   TPU_BUCKET=NAME            bucket name (default: <project>-one-burst-tpu)
#   SA_NAME=hushh-burst        service-account id
#   ROLE_ID=oneBurst           custom role id
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SA_NAME="${SA_NAME:-hushh-burst}"
ROLE_ID="${ROLE_ID:-oneBurst}"
CREATE_KEY="${CREATE_KEY:-false}"
ENABLE_TPU="${ENABLE_TPU:-false}"
TPU_BUCKET="${TPU_BUCKET:-${PROJECT_ID}-one-burst-tpu}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# Least-privilege permissions One needs. Mirrors REQUIRED_PERMISSIONS in
# src/lib/burst/setup.ts, plus the GPU image/network reads and the TPU permissions.
PERMISSIONS=(
  compute.instances.create
  compute.instances.get
  compute.instances.delete
  compute.instances.setMetadata
  compute.instances.setLabels
  compute.disks.create
  compute.subnetworks.use
  compute.zoneOperations.get
)
TPU_PERMISSIONS=(
  tpu.nodes.create
  tpu.nodes.get
  tpu.nodes.delete
  tpu.operations.get
)

say "Project: ${PROJECT_ID}   Region: ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

say "Enabling APIs"
APIS="compute.googleapis.com storage.googleapis.com"
[ "${ENABLE_TPU}" = "true" ] && APIS="${APIS} tpu.googleapis.com"
gcloud services enable ${APIS}

say "Creating the service account (${SA_EMAIL})"
gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${SA_NAME}" --display-name="Hushh One Burst (least privilege)"

say "Creating / updating the custom role (${ROLE_ID})"
ALL_PERMS=("${PERMISSIONS[@]}")
[ "${ENABLE_TPU}" = "true" ] && ALL_PERMS+=("${TPU_PERMISSIONS[@]}")
PERM_CSV="$(IFS=,; echo "${ALL_PERMS[*]}")"
if gcloud iam roles describe "${ROLE_ID}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam roles update "${ROLE_ID}" --project="${PROJECT_ID}" --permissions="${PERM_CSV}" --quiet
else
  gcloud iam roles create "${ROLE_ID}" --project="${PROJECT_ID}" \
    --title="One Burst" --description="Least-privilege role for One burst compute" \
    --permissions="${PERM_CSV}" --quiet
fi

say "Binding the role to the service account"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="projects/${PROJECT_ID}/roles/${ROLE_ID}" \
  --condition=None >/dev/null

if [ "${ENABLE_TPU}" = "true" ]; then
  say "Provisioning the TPU result bucket (gs://${TPU_BUCKET})"
  gcloud storage buckets describe "gs://${TPU_BUCKET}" >/dev/null 2>&1 \
    || gcloud storage buckets create "gs://${TPU_BUCKET}" --location="${REGION}" --uniform-bucket-level-access
  # The TPU node writes results here; the control plane reads them. Bucket-scoped, not project-wide.
  gcloud storage buckets add-iam-policy-binding "gs://${TPU_BUCKET}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin" >/dev/null
  echo "Set ONE_BURST_TPU_RESULT_BUCKET=${TPU_BUCKET}"
fi

if [ "${CREATE_KEY}" = "true" ]; then
  say "Creating a service-account key (one-burst-key.json)"
  gcloud iam service-accounts keys create one-burst-key.json --iam-account="${SA_EMAIL}"
  echo "Paste the contents of one-burst-key.json into One (Settings → Connect your cloud)."
fi

say "Done."
cat <<EOF

Summary
  Service account : ${SA_EMAIL}
  Custom role     : projects/${PROJECT_ID}/roles/${ROLE_ID}
  Region          : ${REGION}
$( [ "${ENABLE_TPU}" = "true" ] && echo "  TPU bucket      : gs://${TPU_BUCKET}" )
$( [ "${CREATE_KEY}" = "true" ] && echo "  Key             : ./one-burst-key.json (paste into One; never commit it)" )

Next: check GPU/TPU quota for ${REGION} (https://console.cloud.google.com/iam-admin/quotas),
then connect in One — it validates everything for you.
EOF
