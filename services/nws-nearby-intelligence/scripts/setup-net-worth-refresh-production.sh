#!/usr/bin/env bash
set -euo pipefail

# One-time, operator-run setup for the NWS net-worth snapshot refresh lane.
#
# This script is deliberately separate from GitHub Actions. It requires explicit
# production coordinates and an immutable image digest, performs no work unless
# --apply is present, and never reads or prints a secret value.

usage() {
  cat <<'EOF'
Usage:
  setup-net-worth-refresh-production.sh \
    --project PROJECT_ID \
    --region REGION \
    --image IMAGE_AT_SHA256 \
    --form6-secret-version VERSION \
    [--bucket BUCKET] \
    [--schedule CRON] \
    [--apply]

Required:
  --project                 GCP project. Never inferred from gcloud config.
  --region                  Cloud Run and Cloud Scheduler region.
  --image                   Artifact Registry image pinned with @sha256:<64 hex>.
  --form6-secret-version    Numbered nws-form6-api-key version. "latest" is rejected.

Optional:
  --bucket                  Published snapshot bucket. Default: <project>-nws-published-snapshots
  --schedule                UTC cron. Default: 17 */6 * * *
  --apply                   Create/update resources. Without it, validate and print the plan.
EOF
}

PROJECT=""
REGION=""
IMAGE=""
FORM6_SECRET_VERSION=""
BUCKET=""
SCHEDULE="17 */6 * * *"
APPLY="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --form6-secret-version)
      FORM6_SECRET_VERSION="${2:-}"
      shift 2
      ;;
    --bucket)
      BUCKET="${2:-}"
      shift 2
      ;;
    --schedule)
      SCHEDULE="${2:-}"
      shift 2
      ;;
    --apply)
      APPLY="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PROJECT" || -z "$REGION" || -z "$IMAGE" || -z "$FORM6_SECRET_VERSION" ]]; then
  echo "--project, --region, --image, and --form6-secret-version are required" >&2
  usage >&2
  exit 2
fi

if [[ "$FORM6_SECRET_VERSION" == "latest" || ! "$FORM6_SECRET_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  echo "--form6-secret-version must be an explicit positive version number" >&2
  exit 2
fi

IMAGE_DIGEST="${IMAGE##*@sha256:}"
IMAGE_REPOSITORY="${IMAGE%@sha256:*}"
IMAGE_BASENAME="${IMAGE_REPOSITORY##*/}"
if [[ "$IMAGE" != "${REGION}-docker.pkg.dev/${PROJECT}/"* || "$IMAGE" != *@sha256:* || "$IMAGE_BASENAME" == *:* || ! "$IMAGE_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo "--image must be a digest-only reference in ${REGION}-docker.pkg.dev/${PROJECT}/...@sha256:<64 lowercase hex>" >&2
  exit 2
fi

if [[ -z "$BUCKET" ]]; then
  BUCKET="${PROJECT}-nws-published-snapshots"
fi
if [[ ! "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]]; then
  echo "Invalid Cloud Storage bucket name: $BUCKET" >&2
  exit 2
fi

for tool in gcloud jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required command is unavailable: $tool" >&2
    exit 1
  fi
done

JOB="nws-net-worth-refresh"
SCHEDULER_JOB="nws-net-worth-refresh"
COLLECTOR_SA_NAME="nws-net-worth-collector"
SCHEDULER_SA_NAME="nws-net-worth-scheduler"
COLLECTOR_SA="${COLLECTOR_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SCHEDULER_SA="${SCHEDULER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
API_RUNTIME_SA="nws-nearby-runtime@${PROJECT}.iam.gserviceaccount.com"
DEPLOYER_SA="nws-nearby-deployer@${PROJECT}.iam.gserviceaccount.com"
FORM6_SECRET="nws-form6-api-key"
SNAPSHOT_PREFIX="published/net-worth-v1.0.0"
SOURCE_REGISTRY_PATH="/app/config/sources.yaml"
SOURCE_REGISTRY_MANIFEST_PATH="/app/config/source-registry-manifest.json"
SOURCE_REGISTRY_SHA256="fb97b845e41998e2d1cdf6c832751605a6285940d885c632883979980511038a"
SOURCE_REGISTRY_VERSION="3"
FORM6_BASE_URL="https://insider-holdings-api-fro3hygenq-uc.a.run.app"
SOFT_DELETE_DURATION="30d"
SOFT_DELETE_SECONDS="2592000"

gcloud projects describe "$PROJECT" --project="$PROJECT" >/dev/null
gcloud auth list --project="$PROJECT" --filter=status:ACTIVE --format='value(account)' | grep -q . || {
  echo "No active gcloud account" >&2
  exit 1
}
gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT" >/dev/null || {
  echo "The immutable image is not readable in project $PROJECT: $IMAGE" >&2
  exit 1
}

if [[ "$APPLY" != "true" ]]; then
  cat <<EOF
Validated dry run. No resources changed.
project:          $PROJECT
region:           $REGION
job:              $JOB
scheduler:        $SCHEDULER_JOB ($SCHEDULE UTC)
collector SA:     $COLLECTOR_SA
scheduler SA:     $SCHEDULER_SA
snapshot bucket:  gs://$BUCKET
snapshot prefix:  $SNAPSHOT_PREFIX
image:            $IMAGE
Form 6 secret:    $FORM6_SECRET:$FORM6_SECRET_VERSION

Re-run with --apply after reviewing this plan.
EOF
  exit 0
fi

for api in iam.googleapis.com run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com storage.googleapis.com artifactregistry.googleapis.com; do
  gcloud services enable "$api" --project="$PROJECT" --quiet
done

ensure_service_account() {
  local account_name="$1"
  local display_name="$2"
  local email="${account_name}@${PROJECT}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "$email" --project="$PROJECT" >/dev/null 2>&1; then
    echo "Service account exists: $email"
  else
    gcloud iam service-accounts create "$account_name" \
      --project="$PROJECT" \
      --display-name="$display_name"
  fi
}

ensure_service_account "$COLLECTOR_SA_NAME" "NWS net-worth snapshot collector"
ensure_service_account "$SCHEDULER_SA_NAME" "NWS net-worth refresh scheduler"

for required_sa in "$API_RUNTIME_SA" "$DEPLOYER_SA"; do
  gcloud iam service-accounts describe "$required_sa" --project="$PROJECT" >/dev/null || {
    echo "Required pre-existing service account is missing: $required_sa" >&2
    exit 1
  }
done

gcloud secrets versions describe "$FORM6_SECRET_VERSION" \
  --secret="$FORM6_SECRET" \
  --project="$PROJECT" \
  --format='value(state)' | grep -qx 'ENABLED' || {
    echo "Secret $FORM6_SECRET version $FORM6_SECRET_VERSION is not ENABLED" >&2
    exit 1
  }

BUCKET_LOCATION="$(printf '%s' "$REGION" | tr '[:lower:]' '[:upper:]')"
if gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" >/dev/null 2>&1; then
  echo "Bucket exists: gs://$BUCKET"
  EXISTING_BUCKET_JSON="$(
    gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" --format=json
  )"
  jq -e --arg region "$BUCKET_LOCATION" '.location == $region' \
    <<<"$EXISTING_BUCKET_JSON" >/dev/null || {
      echo "Existing bucket location does not match the explicit region $REGION" >&2
      exit 1
    }
else
  gcloud storage buckets create "gs://$BUCKET" \
    --project="$PROJECT" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --soft-delete-duration="$SOFT_DELETE_DURATION"
fi

gcloud storage buckets update "gs://$BUCKET" \
  --project="$PROJECT" \
  --uniform-bucket-level-access \
  --public-access-prevention \
  --versioning >/dev/null

BUCKET_JSON="$(gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" --format=json)"
CURRENT_SOFT_DELETE_SECONDS="$(
  jq -r '(.soft_delete_policy.retentionDurationSeconds // "0") | tonumber' <<<"$BUCKET_JSON"
)"
if (( CURRENT_SOFT_DELETE_SECONDS < SOFT_DELETE_SECONDS )); then
  gcloud storage buckets update "gs://$BUCKET" \
    --project="$PROJECT" \
    --soft-delete-duration="$SOFT_DELETE_DURATION" >/dev/null
fi

BUCKET_JSON="$(gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" --format=json)"
jq -e --arg region "$BUCKET_LOCATION" --argjson soft_delete "$SOFT_DELETE_SECONDS" '
  .location == $region and
  .uniform_bucket_level_access == true and
  .public_access_prevention == "enforced" and
  .versioning_enabled == true and
  (.soft_delete_policy.retentionDurationSeconds | tonumber) >= $soft_delete
' <<<"$BUCKET_JSON" >/dev/null || {
  echo "Bucket controls do not match the required production contract" >&2
  exit 1
}

BUCKET_IAM_BEFORE="$(
  gcloud storage buckets get-iam-policy "gs://$BUCKET" --project="$PROJECT" --format=json
)"
jq -e '
  [
    .bindings[]?.members[]?
    | select(. == "allUsers" or . == "allAuthenticatedUsers")
  ] | length == 0
' <<<"$BUCKET_IAM_BEFORE" >/dev/null || {
  echo "Bucket IAM contains a public principal; remove it through reviewed administration" >&2
  exit 1
}

SNAPSHOT_RESOURCE_PREFIX="projects/_/buckets/${BUCKET}/objects/${SNAPSHOT_PREFIX}/"
RELEASE_RESOURCE_PREFIX="${SNAPSHOT_RESOURCE_PREFIX}releases/"
ACTIVE_RESOURCE_NAME="${SNAPSHOT_RESOURCE_PREFIX}active.json"
EXACT_RELEASE_CONDITION="resource.name.startsWith('$RELEASE_RESOURCE_PREFIX')"
EXACT_ACTIVE_CONDITION="resource.name == '$ACTIVE_RESOURCE_NAME'"
EXACT_READ_CONDITION="resource.name.startsWith('$SNAPSHOT_RESOURCE_PREFIX')"

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --project="$PROJECT" \
  --member="serviceAccount:$COLLECTOR_SA" \
  --role="roles/storage.objectCreator" \
  --condition="title=nws_snapshot_create,description=Create immutable releases only,expression=$EXACT_RELEASE_CONDITION" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --project="$PROJECT" \
  --member="serviceAccount:$COLLECTOR_SA" \
  --role="roles/storage.objectAdmin" \
  --condition="title=nws_active_pointer_admin,description=CAS access to the active snapshot pointer only,expression=resource.name == 'projects/_/buckets/${BUCKET}/objects/${SNAPSHOT_PREFIX}/active.json'" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --project="$PROJECT" \
  --member="serviceAccount:$API_RUNTIME_SA" \
  --role="roles/storage.objectViewer" \
  --condition="title=nws_snapshot_api_read,description=Read published net worth snapshots only,expression=$EXACT_READ_CONDITION" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --project="$PROJECT" \
  --member="serviceAccount:$DEPLOYER_SA" \
  --role="roles/storage.objectViewer" \
  --condition="title=nws_snapshot_deployer_read,description=Verify published net worth snapshots only,expression=$EXACT_READ_CONDITION" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --project="$PROJECT" \
  --member="serviceAccount:$DEPLOYER_SA" \
  --role="roles/storage.bucketViewer" \
  --condition=None >/dev/null

BUCKET_IAM_AFTER="$(
  gcloud storage buckets get-iam-policy "gs://$BUCKET" --project="$PROJECT" --format=json
)"
COLLECTOR_MEMBER="serviceAccount:$COLLECTOR_SA"
API_RUNTIME_MEMBER="serviceAccount:$API_RUNTIME_SA"
DEPLOYER_MEMBER="serviceAccount:$DEPLOYER_SA"
jq -e \
  --arg collector "$COLLECTOR_MEMBER" \
  --arg api_runtime "$API_RUNTIME_MEMBER" \
  --arg deployer "$DEPLOYER_MEMBER" \
  --arg release_condition "$EXACT_RELEASE_CONDITION" \
  --arg active_condition "$EXACT_ACTIVE_CONDITION" \
  --arg read_condition "$EXACT_READ_CONDITION" '
  any(.bindings[]?;
    .role == "roles/storage.objectCreator" and
    any(.members[]?; . == $collector) and
    .condition.expression == $release_condition) and
  all(
    .bindings[]?
    | select(.role == "roles/storage.objectCreator" and any(.members[]?; . == $collector));
    .condition.expression == $release_condition) and
  any(.bindings[]?;
    .role == "roles/storage.objectAdmin" and
    any(.members[]?; . == $collector) and
    .condition.expression == $active_condition) and
  all(
    .bindings[]?
    | select(.role == "roles/storage.objectAdmin" and any(.members[]?; . == $collector));
    .condition.expression == $active_condition) and
  any(.bindings[]?;
    .role == "roles/storage.objectViewer" and
    any(.members[]?; . == $api_runtime) and
    .condition.expression == $read_condition) and
  all(
    .bindings[]?
    | select(.role == "roles/storage.objectViewer" and any(.members[]?; . == $api_runtime));
    .condition.expression == $read_condition) and
  any(.bindings[]?;
    .role == "roles/storage.objectViewer" and
    any(.members[]?; . == $deployer) and
    .condition.expression == $read_condition) and
  all(
    .bindings[]?
    | select(.role == "roles/storage.objectViewer" and any(.members[]?; . == $deployer));
    .condition.expression == $read_condition) and
  any(.bindings[]?;
    .role == "roles/storage.bucketViewer" and
    any(.members[]?; . == $deployer))
' <<<"$BUCKET_IAM_AFTER" >/dev/null || {
  echo "Bucket IAM does not match the least-privilege publication contract" >&2
  exit 1
}

gcloud secrets add-iam-policy-binding "$FORM6_SECRET" \
  --project="$PROJECT" \
  --member="serviceAccount:$COLLECTOR_SA" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

gcloud run jobs deploy "$JOB" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$COLLECTOR_SA" \
  --command=python \
  --args=-m,app.jobs.refresh_net_worth \
  --tasks=1 \
  --parallelism=1 \
  --max-retries=2 \
  --task-timeout=15m \
  --cpu=1 \
  --memory=512Mi \
  --set-env-vars="NWS_SNAPSHOT_BUCKET=$BUCKET,NWS_SNAPSHOT_PREFIX=$SNAPSHOT_PREFIX,NWS_SOURCE_REGISTRY_PATH=$SOURCE_REGISTRY_PATH,NWS_SOURCE_REGISTRY_MANIFEST_PATH=$SOURCE_REGISTRY_MANIFEST_PATH,NWS_SOURCE_REGISTRY_SHA256=$SOURCE_REGISTRY_SHA256,NWS_SOURCE_REGISTRY_VERSION=$SOURCE_REGISTRY_VERSION,NWS_FORM6_API_BASE_URL=$FORM6_BASE_URL,NWS_FORM6_TIMEOUT_SECONDS=8,NWS_FORM6_REQUEST_INTERVAL_SECONDS=2.1,NWS_FORM6_MAX_RATE_LIMIT_RETRIES=2,NWS_FORM6_MAX_RETRY_AFTER_SECONDS=30,NWS_FORM6_REFRESH_DEADLINE_SECONDS=600,NWS_SNAPSHOT_MAX_RECORDS_PER_JURISDICTION=1000" \
  --set-secrets="NWS_FORM6_API_KEY=${FORM6_SECRET}:${FORM6_SECRET_VERSION}" \
  --labels="service=nws-nearby-intelligence,component=net-worth-refresh" \
  --quiet

gcloud run jobs add-iam-policy-binding "$JOB" \
  --project="$PROJECT" \
  --region="$REGION" \
  --member="serviceAccount:$SCHEDULER_SA" \
  --role="roles/run.invoker" >/dev/null
gcloud run jobs add-iam-policy-binding "$JOB" \
  --project="$PROJECT" \
  --region="$REGION" \
  --member="serviceAccount:$DEPLOYER_SA" \
  --role="roles/run.invoker" >/dev/null
gcloud run jobs add-iam-policy-binding "$JOB" \
  --project="$PROJECT" \
  --region="$REGION" \
  --member="serviceAccount:$DEPLOYER_SA" \
  --role="roles/run.developer" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$COLLECTOR_SA" \
  --project="$PROJECT" \
  --member="serviceAccount:$DEPLOYER_SA" \
  --role="roles/iam.serviceAccountUser" >/dev/null

SCHEDULER_URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
SCHEDULER_ARGS=(
  "$SCHEDULER_JOB"
  --project="$PROJECT"
  --location="$REGION"
  --schedule="$SCHEDULE"
  --time-zone="Etc/UTC"
  --uri="$SCHEDULER_URI"
  --http-method=POST
  --oauth-service-account-email="$SCHEDULER_SA"
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
  --message-body="{}"
  --attempt-deadline=60s
  --max-retry-attempts=3
  --min-backoff=30s
  --max-backoff=5m
  --max-doublings=3
  --quiet
)

if gcloud scheduler jobs describe "$SCHEDULER_JOB" --project="$PROJECT" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${SCHEDULER_ARGS[@]}" \
    --update-headers="Content-Type=application/json"
else
  gcloud scheduler jobs create http "${SCHEDULER_ARGS[@]}" \
    --headers="Content-Type=application/json"
fi

JOB_JSON="$(gcloud run jobs describe "$JOB" --project="$PROJECT" --region="$REGION" --format=json)"
jq -e \
  --arg image "$IMAGE" \
  --arg sa "$COLLECTOR_SA" \
  --arg registry_sha256 "$SOURCE_REGISTRY_SHA256" \
  --arg registry_version "$SOURCE_REGISTRY_VERSION" \
  --arg form6_secret "$FORM6_SECRET" \
  --arg form6_secret_version "$FORM6_SECRET_VERSION" '
  def task_template:
    (.template?.template? // .spec?.template?.spec?.template?.spec?);
  def secret_name:
    (.valueFrom?.secretKeyRef?.name // .valueSource?.secretKeyRef?.secret // "");
  def secret_version:
    (.valueFrom?.secretKeyRef?.key // .valueSource?.secretKeyRef?.version // "");
  task_template as $task |
  ($task.serviceAccount // $task.serviceAccountName) == $sa and
  $task.containers[0].image == $image and
  $task.containers[0].command == ["python"] and
  $task.containers[0].args == ["-m", "app.jobs.refresh_net_worth"] and
  any($task.containers[0].env[]?;
    .name == "NWS_SOURCE_REGISTRY_SHA256" and .value == $registry_sha256) and
  any($task.containers[0].env[]?;
    .name == "NWS_SOURCE_REGISTRY_VERSION" and .value == $registry_version) and
  any($task.containers[0].env[]?;
    .name == "NWS_FORM6_REQUEST_INTERVAL_SECONDS" and .value == "2.1") and
  any($task.containers[0].env[]?;
    .name == "NWS_FORM6_MAX_RATE_LIMIT_RETRIES" and .value == "2") and
  any($task.containers[0].env[]?;
    .name == "NWS_FORM6_MAX_RETRY_AFTER_SECONDS" and .value == "30") and
  any($task.containers[0].env[]?;
    .name == "NWS_FORM6_REFRESH_DEADLINE_SECONDS" and .value == "600") and
  any($task.containers[0].env[]?;
    .name == "NWS_FORM6_API_KEY" and
    ((secret_name) == $form6_secret or (secret_name | endswith("/secrets/" + $form6_secret))) and
    (secret_version) == $form6_secret_version)
' <<<"$JOB_JSON" >/dev/null || {
  echo "Cloud Run Job does not match its pinned image, identity, registry, or secret" >&2
  exit 1
}

gcloud scheduler jobs describe "$SCHEDULER_JOB" \
  --project="$PROJECT" \
  --location="$REGION" \
  --format='yaml(name,state,schedule,timeZone,httpTarget.uri,httpTarget.oauthToken.serviceAccountEmail)'

echo "Production refresh lane is provisioned. The setup did not execute the job."
