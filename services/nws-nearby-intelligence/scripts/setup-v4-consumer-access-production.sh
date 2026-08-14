#!/usr/bin/env bash
set -euo pipefail

# Validate or provision the v4 policy/consent infrastructure. The key is read
# only into a mode-0600 temporary file for digest binding; it is never printed.
# This script never creates an SSH key.

usage() {
  cat <<'EOF'
Usage:
  setup-v4-consumer-access-production.sh \
    --project PROJECT_ID \
    --region REGION \
    --registry-sha256 SHA256 \
    --registry-secret-version VERSION \
    --consumer-key-secret-version VERSION \
    [--consumer-project PROJECT_ID] \
    [--consumer-service-account EMAIL] \
    [--apply]

Without --apply, this validates inputs and prints the exact resource plan.
EOF
}

PROJECT=""
REGION=""
REGISTRY_SHA256=""
REGISTRY_SECRET_VERSION=""
CONSUMER_KEY_SECRET_VERSION=""
CONSUMER_PROJECT="hushone-app"
CONSUMER_SERVICE_ACCOUNT="one-runtime@hushone-app.iam.gserviceaccount.com"
APPLY="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --registry-sha256) REGISTRY_SHA256="${2:-}"; shift 2 ;;
    --registry-secret-version) REGISTRY_SECRET_VERSION="${2:-}"; shift 2 ;;
    --consumer-key-secret-version) CONSUMER_KEY_SECRET_VERSION="${2:-}"; shift 2 ;;
    --consumer-project) CONSUMER_PROJECT="${2:-}"; shift 2 ;;
    --consumer-service-account) CONSUMER_SERVICE_ACCOUNT="${2:-}"; shift 2 ;;
    --apply) APPLY="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$PROJECT" || -z "$REGION" || -z "$REGISTRY_SHA256" || \
      -z "$REGISTRY_SECRET_VERSION" || -z "$CONSUMER_KEY_SECRET_VERSION" ]]; then
  usage >&2
  exit 2
fi
if [[ ! "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "Invalid project ID" >&2
  exit 2
fi
if [[ ! "$REGION" =~ ^[a-z]+-[a-z]+[0-9]$ ]]; then
  echo "Invalid region" >&2
  exit 2
fi
if [[ ! "$REGISTRY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "--registry-sha256 must be 64 lowercase hex characters" >&2
  exit 2
fi
if [[ ! "$CONSUMER_PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "Invalid consumer project ID" >&2
  exit 2
fi
if [[ ! "$CONSUMER_SERVICE_ACCOUNT" =~ ^[A-Za-z0-9][-A-Za-z0-9.]{2,126}@(developer\.gserviceaccount\.com|[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com)$ ]]; then
  echo "Invalid consumer service-account email" >&2
  exit 2
fi
for version in "$REGISTRY_SECRET_VERSION" "$CONSUMER_KEY_SECRET_VERSION"; do
  if [[ "$version" == "latest" || ! "$version" =~ ^[1-9][0-9]*$ ]]; then
    echo "Secret versions must be explicit positive integers" >&2
    exit 2
  fi
done
for tool in gcloud jq shasum; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $tool" >&2
    exit 1
  }
done

RUNTIME_SA="nws-nearby-runtime@${PROJECT}.iam.gserviceaccount.com"
DEPLOYER_SA="nws-nearby-deployer@${PROJECT}.iam.gserviceaccount.com"
REGISTRY_SECRET="nws-consumer-access-registry"
CONSUMER_KEY_SECRET="nws-husshone-v4-api-key" # gitleaks:allow -- resource name, not a key
CONSENT_BUCKET="${PROJECT}-nws-consent-receipts"

gcloud projects describe "$PROJECT" --project="$PROJECT" >/dev/null
for service_account in "$RUNTIME_SA" "$DEPLOYER_SA"; do
  gcloud iam service-accounts describe "$service_account" \
    --project="$PROJECT" >/dev/null
done
gcloud iam service-accounts describe "$CONSUMER_SERVICE_ACCOUNT" \
  --project="$CONSUMER_PROJECT" >/dev/null
gcloud secrets versions describe "$REGISTRY_SECRET_VERSION" \
  --secret="$REGISTRY_SECRET" --project="$PROJECT" \
  --format='value(state)' | grep -qx ENABLED
gcloud secrets versions describe "$CONSUMER_KEY_SECRET_VERSION" \
  --secret="$CONSUMER_KEY_SECRET" --project="$PROJECT" \
  --format='value(state)' | grep -qx ENABLED

LIFECYCLE_FILE="$(mktemp)"
REGISTRY_FILE="$(mktemp)"
CONSUMER_KEY_FILE="$(mktemp)"
cleanup() {
  rm -f "$LIFECYCLE_FILE" "$REGISTRY_FILE" "$CONSUMER_KEY_FILE"
}
trap cleanup EXIT
chmod 600 "$REGISTRY_FILE" "$CONSUMER_KEY_FILE"

# Validate exact registry bytes and credential binding before any mutation.
gcloud secrets versions access "$REGISTRY_SECRET_VERSION" \
  --secret="$REGISTRY_SECRET" --project="$PROJECT" >"$REGISTRY_FILE"
gcloud secrets versions access "$CONSUMER_KEY_SECRET_VERSION" \
  --secret="$CONSUMER_KEY_SECRET" --project="$PROJECT" >"$CONSUMER_KEY_FILE"
ACTUAL_REGISTRY_SHA256="$(shasum -a 256 "$REGISTRY_FILE" | awk '{print $1}')"
if [[ "$ACTUAL_REGISTRY_SHA256" != "$REGISTRY_SHA256" ]]; then
  echo "Consumer registry does not match the pinned SHA-256" >&2
  exit 1
fi
KEY_BYTES="$(wc -c <"$CONSUMER_KEY_FILE" | tr -d '[:space:]')"
if [[ "$KEY_BYTES" != "52" ]] || ! grep -Eq '^nws_(live|test)_[A-Za-z0-9_-]{43}$' "$CONSUMER_KEY_FILE"; then
  echo "Consumer key does not match the canonical credential format" >&2
  exit 1
fi
CONSUMER_KEY_SHA256="$(shasum -a 256 "$CONSUMER_KEY_FILE" | awk '{print $1}')"
jq -e '
  .schema_version == "nws-consumer-access-registry-v1" and
  (.registry_version | type == "number" and . >= 1) and
  (.consumers | type == "array" and length >= 1) and
  all(.consumers[];
    (.api_key_sha256 | test("^[0-9a-f]{64}$")) and
    (.kill_switch | type == "boolean") and
    (.grants | type == "array" and length >= 1))
' "$REGISTRY_FILE" >/dev/null
jq -e --arg key_sha256 "$CONSUMER_KEY_SHA256" '
  any(.consumers[]; .api_key_sha256 == $key_sha256)
' "$REGISTRY_FILE" >/dev/null || {
  echo "Consumer key is not bound by the reviewed registry" >&2
  exit 1
}

if [[ "$APPLY" != "true" ]]; then
  cat <<EOF
Validated dry run. No resources changed.
project:                 $PROJECT
region:                  $REGION
runtime identity:        $RUNTIME_SA
registry secret:         $REGISTRY_SECRET:$REGISTRY_SECRET_VERSION
consumer key secret:     $CONSUMER_KEY_SECRET:$CONSUMER_KEY_SECRET_VERSION
consumer project:        $CONSUMER_PROJECT
consumer identity:       $CONSUMER_SERVICE_ACCOUNT
single-use receipt store: gs://$CONSENT_BUCKET
EOF
  exit 0
fi

gcloud services enable storage.googleapis.com secretmanager.googleapis.com \
  --project="$PROJECT" --quiet

if ! gcloud storage buckets describe "gs://$CONSENT_BUCKET" \
  --project="$PROJECT" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$CONSENT_BUCKET" \
    --project="$PROJECT" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention --quiet
fi
gcloud storage buckets update "gs://$CONSENT_BUCKET" \
  --project="$PROJECT" --uniform-bucket-level-access \
  --public-access-prevention --quiet >/dev/null

printf '%s\n' '{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}' \
  >"$LIFECYCLE_FILE"
gcloud storage buckets update "gs://$CONSENT_BUCKET" --project="$PROJECT" \
  --lifecycle-file="$LIFECYCLE_FILE" --quiet >/dev/null

CONSENT_OBJECT_PREFIX="projects/_/buckets/${CONSENT_BUCKET}/objects/used/"
CONSENT_CREATE_CONDITION="resource.name.startsWith('${CONSENT_OBJECT_PREFIX}')"
gcloud storage buckets remove-iam-policy-binding "gs://$CONSENT_BUCKET" \
  --project="$PROJECT" --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/storage.objectCreator --condition=None --quiet >/dev/null 2>&1 || true
gcloud storage buckets add-iam-policy-binding "gs://$CONSENT_BUCKET" \
  --project="$PROJECT" --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/storage.objectCreator \
  --condition="title=nws_consent_receipt_create,description=Create single-use receipt markers only,expression=$CONSENT_CREATE_CONDITION" \
  --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$CONSENT_BUCKET" \
  --project="$PROJECT" --member="serviceAccount:$DEPLOYER_SA" \
  --role=roles/storage.bucketViewer --condition=None --quiet >/dev/null
gcloud secrets add-iam-policy-binding "$REGISTRY_SECRET" \
  --project="$PROJECT" --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/secretmanager.secretAccessor --quiet >/dev/null
gcloud secrets add-iam-policy-binding "$CONSUMER_KEY_SECRET" \
  --project="$PROJECT" --member="serviceAccount:$DEPLOYER_SA" \
  --role=roles/secretmanager.secretAccessor --quiet >/dev/null
gcloud secrets add-iam-policy-binding "$CONSUMER_KEY_SECRET" \
  --project="$PROJECT" --member="serviceAccount:$CONSUMER_SERVICE_ACCOUNT" \
  --role=roles/secretmanager.secretAccessor --quiet >/dev/null

BUCKET_JSON="$(gcloud storage buckets describe "gs://$CONSENT_BUCKET" \
  --project="$PROJECT" --format=json)"
jq -e --arg region "$(printf '%s' "$REGION" | tr '[:lower:]' '[:upper:]')" '
  .location == $region and
  .uniform_bucket_level_access == true and
  .public_access_prevention == "enforced" and
  any(.lifecycle_config.rule[]?;
    .action.type == "Delete" and .condition.age == 1)
' <<<"$BUCKET_JSON" >/dev/null

BUCKET_IAM="$(gcloud storage buckets get-iam-policy "gs://$CONSENT_BUCKET" \
  --project="$PROJECT" --format=json)"
jq -e \
  --arg runtime "serviceAccount:$RUNTIME_SA" \
  --arg condition "$CONSENT_CREATE_CONDITION" '
  [
    .bindings[]?.members[]?
    | select(. == "allUsers" or . == "allAuthenticatedUsers")
  ] | length == 0 and
  any(.bindings[]?;
    .role == "roles/storage.objectCreator" and
    any(.members[]?; . == $runtime) and
    .condition.expression == $condition) and
  all(
    .bindings[]?
    | select(.role == "roles/storage.objectCreator" and any(.members[]?; . == $runtime));
    .condition.expression == $condition)
' <<<"$BUCKET_IAM" >/dev/null

echo "v4 consumer-access infrastructure verified. No secret values were printed."
