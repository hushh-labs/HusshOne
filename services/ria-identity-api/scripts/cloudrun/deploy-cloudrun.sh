#!/usr/bin/env bash
# Deploy the RIA Identity API to Cloud Run — SCALE TO ZERO.
#
# ============================================================================================
# WHY THIS PATH EXISTS
# ============================================================================================
# scripts/gcp-vm/deploy-gcp-vm.sh puts this service on a dedicated e2-medium with Caddy and a
# Cloud SQL Auth Proxy sidecar unit. That VM bills 24/7 — roughly $25-30/month — whether or not
# a single adviser types a phone number into an onboarding form. This endpoint is used ONCE per
# adviser during onboarding, so an always-on VM is almost entirely idle cost.
#
# This script is the alternative: the same code, the same env contract, on Cloud Run with
# --min-instances=0. Idle costs nothing. You pay per request and per request-second.
#
# NEITHER PATH REPLACES THE OTHER. Running this does not touch, stop or reconfigure
# ria-identity-api-vm, and running the VM deploy does not touch this service. They share three
# Secret Manager secrets and one Cloud SQL instance, all read-only, and both can serve at once.
#
# ============================================================================================
# THIS SCRIPT DOES NOT RUN ITSELF
# ============================================================================================
# It is invoked by a human, from this directory, on purpose. It is deliberately NOT referenced
# by /cloudbuild.yaml (which deploys the `one` app to a DIFFERENT project, hushone-app) and it
# is wired into no trigger, no CI job and no scheduler. Nothing in this repo executes it.
#
#   ./scripts/cloudrun/deploy-cloudrun.sh              # the real thing
#   DRY_RUN=1 ./scripts/cloudrun/deploy-cloudrun.sh    # print every gcloud call, change nothing
#
# It is IDEMPOTENT: run it twice and you get the same service, one extra image tag, and no
# duplicated cloud resources. Every check is describe-or-create and every IAM call is
# add-iam-policy-binding (never set-iam-policy — that would drop other members).
#
# ============================================================================================
# WHAT EACH FLAG ON THE `gcloud run deploy` BELOW IS FOR
# ============================================================================================
#   --min-instances=0        THE COST REQUIREMENT. No warm instance is kept. An idle service
#                            bills $0 for compute; the first request after idle pays a cold
#                            start (~1-2s here: no build step, one dependency, the cache
#                            snapshot warms from /tmp or starts cold).
#   --max-instances=5        ANTI-RUNAWAY. A public endpoint with a scale-to-zero autoscaler is
#                            also a scale-to-your-credit-limit autoscaler. 5 x 80 concurrent is
#                            far more capacity than the 30 req/min per-caller limit can ever
#                            legitimately need, and it caps the worst case if someone gets the
#                            key or hammers the open /health.
#   --concurrency=80         Deliberately HIGH, and not only for cost. The rate limiter and the
#                            daily cap are per-process in-memory (scripts/lib/rate-limit.mjs),
#                            so the fewer instances a given load spreads across, the closer the
#                            enforced limit is to the configured one. See THE DAILY CAP below.
#   --cpu=1 --memory=512Mi   Node + pg + three in-memory caches. Measured shape: the persisted
#                            caches are capped at 100k/20k entries and the process is idle
#                            between requests.
#   --cpu-throttling         Explicit, because it is the default that makes scale-to-zero cheap:
#                            CPU is allocated only while a request is in flight. The 5-minute
#                            snapshot timer may therefore not fire between requests — that is
#                            fine, cache.mjs treats a missing snapshot as "start cold".
#   --cpu-boost              Full CPU during container start. Costs a few hundred ms of boosted
#                            CPU per cold start and removes most of the cold-start penalty that
#                            min-instances=0 buys us.
#   --timeout=120s           One lookup fans out to IAPD (20s timeout, 2 retries) plus Places.
#                            120s is generous for that and short enough that a wedged request
#                            cannot bill for 15 minutes.
#   --port=8080              Matches EXPOSE/PORT in the Dockerfile and config.mjs's default.
#   --allow-unauthenticated  Same posture as the VM: the endpoint is public and the BEARER KEY
#                            is the gate (config.mjs fails CLOSED once a key is configured),
#                            backed by the per-minute bucket and the daily cap. This adds
#                            roles/run.invoker for allUsers ON THIS SERVICE ONLY.
#   --add-cloudsql-instances Mounts the Cloud SQL unix socket at /cloudsql/<conn>. ADD, not SET,
#                            so it cannot drop an instance someone else attached.
#   --set-secrets            Runtime secret injection. See THE SECRETS below.
#   --set-env-vars           Authoritative env for this service (it replaces the plain env vars
#                            wholesale, which is what makes re-running this deterministic).
#                            No value below contains a comma, so the default comma delimiter is
#                            safe; if you add one that does, switch to --set-env-vars=^@^k=v@k=v.
#
# ============================================================================================
# THE DATABASE — unix socket, and the port that is easy to get wrong
# ============================================================================================
# There is no Cloud SQL Auth Proxy process on Cloud Run. --add-cloudsql-instances mounts the
# socket directory directly, so:
#
#   RIA_DB_HOST=/cloudsql/hushh-tech-prod:us-central1:hushh-directories-db
#   RIA_DB_PORT=5432        <-- NOT 5439
#
# node-postgres switches to unix-socket mode when the host starts with "/" and then connects to
# `${host}/.s.PGSQL.${port}` (pg/lib/client.js). Cloud Run creates that socket at
# .s.PGSQL.5432. The service's own default of 5439 is the loopback port the VM's Auth Proxy
# listens on — carry it over here and every query fails with ENOENT on a path that looks right.
#
# THE SERVICE STILL STARTS IF THE DATABASE IS ABSENT, and that is required, not incidental:
# createStore() opens no socket at import, the live Places -> IAPD chain still resolves a phone
# on its own, and /health reports `sources.formAdvDb.reachable:false` honestly. Do not add a
# startup probe that depends on the database. Verified against this exact env, with no socket
# present: boots, /health returns ok:true with reachable:false, and the error names the path
# `/cloudsql/<conn>/.s.PGSQL.5432` — which is where the 5432-not-5439 rule above comes from.
#
# RIA_DB_ENABLED is set to `on` below because this deployment attaches Cloud SQL deliberately.
# config.mjs treats the database as OPTIONAL (auto|on|off; `auto` infers it from RIA_DB_PASSWORD
# or RIA_DB_HOST being set, which would also resolve to enabled here) — so if you want the
# cheapest possible Cloud Run footprint, `RIA_DB_ENABLED=off` with no --add-cloudsql-instances
# is a SUPPORTED STANDALONE MODE, not a degraded one: the live Places -> IAPD chain answers the
# same question with no database of ours in the loop.
#
# ============================================================================================
# THE SECRETS — three, all pre-existing, none created or rotated here
# ============================================================================================
#   ria-identity-api-key          -> RIA_IDENTITY_API_KEY   our own bearer key. Shared with the
#                                    VM deploy, which auto-creates it. This script creates it
#                                    only if it does not exist at all.
#   directories-db-password       -> RIA_DB_PASSWORD        SHARED with ria-directory and the
#                                    rest of the directories fleet.
#   hotel-scraper-places-api-key  -> PLACES_API_KEY         SHARED with hotel-scraper.
#
# The two shared secrets are read-only here and there is no create-if-missing branch for them
# on purpose: minting a new value would hand this service a password the resource owner does
# not have, and adding a new VERSION is a rotation that would break the other consumers.
#
# Cloud Run validates every secret reference when a revision starts, so a runtime identity that
# cannot read one produces a revision that NEVER becomes ready while the old one keeps serving
# — a deploy that looks like a no-op. The IAM grants below therefore happen BEFORE the deploy,
# in their own step. (`scripts/safe-changes` R1.)
#
# ALTERNATIVE, if you want the values out of the process environment entirely: config.mjs also
# accepts `<NAME>_FILE` pointing at a file, which is exactly what a Cloud Run secret volume
# produces. That would be:
#     --set-secrets=/secrets/api-key=ria-identity-api-key:latest   (one mount per secret dir)
#     --set-env-vars=RIA_IDENTITY_API_KEY_FILE=/secrets/api-key,...
# Env injection is used below because it is the simplest thing that works and matches the VM's
# env-file model; switch if a threat model needs it.
#
# ============================================================================================
# THE DAILY CAP IS WEAKER ON CLOUD RUN THAN ON THE VM. READ THIS.
# ============================================================================================
# DailyCap and RateLimiter are per-process, in memory. On the VM that is one process, forever,
# so DAILY_LOOKUP_CAP=2000 means exactly 2000 disclosing requests per day. On Cloud Run:
#
#   * the cap is per INSTANCE, so N instances multiply it, and
#   * an instance that scales to zero LOSES ITS COUNTER — a patient enumerator can idle the
#     service out (~15 min) and come back to a fresh allowance.
#
# The cap is a product constraint against bulk enumeration of the number space, not a cost
# control (config.mjs is explicit about this), so this script does two things about it:
#
#   1. Sets DAILY_LOOKUP_CAP = 2000 / MAX_INSTANCES (= 400 at max-instances=5), which keeps the
#      designed FLEET-WIDE ceiling of 2000/day intact. If you change MAX_INSTANCES, keep the
#      product of the two at 2000 or change it consciously.
#   2. Cannot fix the reset-on-cold-start hole at all. That needs a shared counter (Cloud SQL
#      or Memorystore) and is not in this change. Until then: if hard anti-enumeration
#      enforcement matters more than the idle bill, the VM path is the stronger posture, or run
#      this service with --min-instances=1 and DAILY_LOOKUP_CAP=2000.
#
# ============================================================================================
set -euo pipefail

PROJECT="${PROJECT:-hushh-tech-prod}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-ria-identity-api}"

# Artifact Registry repo name matches the repo-wide convention in /cloudbuild.yaml.
AR_REPO="${AR_REPO:-cloud-run-source-deploy}"
IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${SERVICE}}"
BUILD_REGION="${BUILD_REGION:-us-central1}"   # set to "global" if regional builds are disabled

# Scaling. MIN_INSTANCES=0 is the whole point of this file; do not "temporarily" raise it.
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-5}"
CONCURRENCY="${CONCURRENCY:-80}"
CPU="${CPU:-1}"
MEMORY="${MEMORY:-512Mi}"
TIMEOUT="${TIMEOUT:-120s}"

# Fleet-wide daily disclosure ceiling, divided across the instances that can hold a counter.
# See "THE DAILY CAP IS WEAKER ON CLOUD RUN" above.
FLEET_DAILY_LOOKUP_CAP="${FLEET_DAILY_LOOKUP_CAP:-2000}"
DAILY_LOOKUP_CAP="${DAILY_LOOKUP_CAP:-$(( FLEET_DAILY_LOOKUP_CAP / (MAX_INSTANCES < 1 ? 1 : MAX_INSTANCES) ))}"

# 1 = one trusted hop (Cloud Run's own front end, which appends the real client to
# X-Forwarded-For). The limiter reads the RIGHTMOST entry because of it, so a caller cannot
# reset their own quota by sending a fake XFF.
# SET THIS TO 2 IF YOU PUT AN EXTERNAL HTTPS LOAD BALANCER IN FRONT — the LB adds its own entry
# and at 1 every request would appear to come from the LB, collapsing all callers into one
# bucket. Nothing warns you; the limit just stops being per-caller.
TRUSTED_PROXY_COUNT="${TRUSTED_PROXY_COUNT:-1}"

# Cloud SQL (Postgres 16, shared directories instance — read-only for this service).
INSTANCE_CONNECTION_NAME="${INSTANCE_CONNECTION_NAME:-hushh-tech-prod:us-central1:hushh-directories-db}"
DB_NAME="${DB_NAME:-ria}"
DB_USER="${DB_USER:-directories}"
# on | auto | off. `off` + ATTACH_CLOUD_SQL=0 is the supported no-database deployment.
DB_ENABLED="${DB_ENABLED:-on}"
ATTACH_CLOUD_SQL="${ATTACH_CLOUD_SQL:-1}"
# 5432 because Cloud Run's socket is /cloudsql/<conn>/.s.PGSQL.5432. Not 5439. See above.
DB_PORT="${DB_PORT:-5432}"

# Ours, auto-created if absent (same secret the VM deploy owns).
SECRET_API_KEY="${SECRET_API_KEY:-ria-identity-api-key}"
# SHARED and PRE-EXISTING. Never created, never rotated, never printed.
SECRET_DB_PASSWORD="${SECRET_DB_PASSWORD:-directories-db-password}"
SECRET_PLACES_API_KEY="${SECRET_PLACES_API_KEY:-hotel-scraper-places-api-key}"

SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"        # empty = the project's default compute SA
ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-1}"
DRY_RUN="${DRY_RUN:-0}"

# --- helpers ---------------------------------------------------------------------------------
say() { printf '\n== %s ==\n' "$*"; }

# Any call that CHANGES cloud state. In DRY_RUN it is printed and skipped.
mutate() {
  if [[ "$DRY_RUN" == "1" ]]; then printf 'DRY-RUN would run: %s\n' "$*"; return 0; fi
  "$@"
}

# Query for a value. In DRY_RUN, emit the placeholder instead of calling out, so the whole
# script can be exercised with no credentials and no network.
q() {
  local placeholder="$1"; shift
  if [[ "$DRY_RUN" == "1" ]]; then printf '%s' "$placeholder"; return 0; fi
  "$@"
}

# Existence probe. In DRY_RUN everything is assumed to exist already.
exists() {
  if [[ "$DRY_RUN" == "1" ]]; then return 0; fi
  "$@" >/dev/null 2>&1
}

command -v gcloud >/dev/null 2>&1 || { echo "gcloud not found on PATH." >&2; exit 1; }
[[ -n "$PROJECT" ]] || { echo "PROJECT is required." >&2; exit 1; }
[[ -n "$INSTANCE_CONNECTION_NAME" ]] || { echo "INSTANCE_CONNECTION_NAME is required." >&2; exit 1; }

# Run from the service root whatever directory the caller is sitting in — the build context
# below is "." and shipping the wrong tree is a genuinely confusing failure.
SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$SERVICE_DIR"
[[ -f server.mjs ]]  || { echo "server.mjs not found in $SERVICE_DIR — wrong directory?" >&2; exit 1; }
[[ -f Dockerfile ]]  || { echo "Dockerfile not found in $SERVICE_DIR." >&2; exit 1; }

# Timestamp FIRST so every run produces a distinct, immutable tag (re-running with the same
# commit must not overwrite an existing tag — that destroys the provenance of a live revision).
# The short SHA is a label, not an identity: in a shared checkout HEAD may be another session's
# branch (scripts/safe-changes R10), which is exactly why it is not the whole tag.
TAG="${TAG:-$(date -u +%Y%m%d-%H%M%S)-$(git -C "$SERVICE_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)}"

echo "Deploying $SERVICE to Cloud Run"
echo "  project        : $PROJECT"
echo "  region         : $REGION"
echo "  image          : ${IMAGE}:${TAG}"
echo "  scaling        : min=$MIN_INSTANCES max=$MAX_INSTANCES concurrency=$CONCURRENCY (scale to zero)"
if [[ "$ATTACH_CLOUD_SQL" == "1" ]]; then
  echo "  cloud sql      : $INSTANCE_CONNECTION_NAME (unix socket, port $DB_PORT, RIA_DB_ENABLED=$DB_ENABLED)"
else
  echo "  cloud sql      : NOT ATTACHED (RIA_DB_ENABLED=off — live Places + IAPD only, a supported mode)"
fi
echo "  daily cap      : $DAILY_LOOKUP_CAP per instance x $MAX_INSTANCES = $((DAILY_LOOKUP_CAP * MAX_INSTANCES)) fleet-wide"
[[ "$DRY_RUN" == "1" ]] && echo "  MODE           : DRY RUN — nothing will be created or changed"

# --- 1. APIs ---------------------------------------------------------------------------------
# Idempotent: only enables what is actually missing, so a re-run is silent.
say "APIs"
NEEDED_APIS=(run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com)
ENABLED="$(q "$(printf '%s\n' "${NEEDED_APIS[@]}")" gcloud services list --enabled --project "$PROJECT" --format='value(config.name)')"
for API in "${NEEDED_APIS[@]}"; do
  if grep -qx "$API" <<<"$ENABLED"; then
    echo "  ok      $API"
  else
    echo "  enabling $API"
    mutate gcloud services enable "$API" --project "$PROJECT"
  fi
done

# --- 2. secrets ------------------------------------------------------------------------------
# Values are NEVER read by this script. Cloud Run resolves the references at revision start, so
# the secrets never pass through this machine, this shell, or `ps`.
say "Secrets"
if exists gcloud secrets describe "$SECRET_API_KEY" --project "$PROJECT"; then
  echo "  ok      $SECRET_API_KEY (exists — value not read)"
else
  echo "  creating $SECRET_API_KEY (random 32-byte hex)"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'DRY-RUN would run: gcloud secrets create %s --data-file=- (value piped, never printed)\n' "$SECRET_API_KEY"
  else
    printf '%s' "$(openssl rand -hex 32)" \
      | gcloud secrets create "$SECRET_API_KEY" --data-file=- --replication-policy=automatic --project "$PROJECT"
  fi
fi
for S in "$SECRET_DB_PASSWORD" "$SECRET_PLACES_API_KEY"; do
  if exists gcloud secrets describe "$S" --project "$PROJECT"; then
    echo "  ok      $S (SHARED — read-only here, never created, never rotated)"
  else
    echo "Missing Secret Manager secret: $S. This deploy does not create it — it is shared with another service." >&2
    exit 1
  fi
done

# --- 3. IAM for the RUNTIME identity, BEFORE any secret is bound -----------------------------
# The default compute SA of hushh-tech-prod is the same identity the VM deploy already grants
# these two roles to, so on an existing fleet both calls are no-ops. Additive bindings only:
# set-iam-policy would replace the whole policy and silently drop every other member.
say "IAM"
if [[ -n "$SERVICE_ACCOUNT" ]]; then
  RUNTIME_SA="$SERVICE_ACCOUNT"
else
  PROJECT_NUMBER="$(q '000000000000' gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
echo "  runtime identity: $RUNTIME_SA"
for ROLE in roles/secretmanager.secretAccessor roles/cloudsql.client; do
  echo "  + $ROLE"
  mutate gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${RUNTIME_SA}" --role "$ROLE" \
    --condition=None --quiet >/dev/null
done

# --- 4. Artifact Registry --------------------------------------------------------------------
say "Artifact Registry"
if exists gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$PROJECT"; then
  echo "  ok      ${REGION}/${AR_REPO}"
else
  echo "  creating ${REGION}/${AR_REPO}"
  mutate gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker --location "$REGION" --project "$PROJECT" \
    --description "Cloud Run images"
fi

# --- 5. build --------------------------------------------------------------------------------
# Built by Cloud Build from the Dockerfile in this directory. No local docker daemon needed.
# --ignore-file=.dockerignore makes the uploaded source match the image build context exactly
# AND stops gcloud writing a .gcloudignore into the working tree. (.dockerignore therefore must
# not exclude the Dockerfile itself — it doesn't; see the comment at the top of that file.)
say "Build ${IMAGE}:${TAG}"
mutate gcloud builds submit "$SERVICE_DIR" \
  --project "$PROJECT" \
  --region "$BUILD_REGION" \
  --tag "${IMAGE}:${TAG}" \
  --ignore-file=.dockerignore
# If this fails on the push with a permissions error, the build service account needs
# roles/artifactregistry.writer — grant it ADDITIVELY, then re-run:
#   gcloud projects add-iam-policy-binding "$PROJECT" \
#     --member "serviceAccount:${RUNTIME_SA}" --role roles/artifactregistry.writer --condition=None

# --- 6. deploy -------------------------------------------------------------------------------
say "Deploy"

# Plain env. Cloud SQL is optional in config.mjs, so the database half is only added when this
# deployment actually attaches an instance — pointing RIA_DB_HOST at a /cloudsql socket that was
# never mounted would be a config that describes a database nobody can reach.
ENV_VARS="NODE_ENV=production"
ENV_VARS="${ENV_VARS},TRUSTED_PROXY_COUNT=${TRUSTED_PROXY_COUNT}"
ENV_VARS="${ENV_VARS},DAILY_LOOKUP_CAP=${DAILY_LOOKUP_CAP}"
ENV_VARS="${ENV_VARS},CACHE_SNAPSHOT_PATH=/tmp/ria-identity-cache-snapshot.json"
# Vertex adjudicates fuzzy name matches (oidc_name_match) via the runtime service account's ADC.
# Without a project it is "not configured" and that arm fails CLOSED — nothing breaks, the
# claimant just falls back to verifying a work email instead. Set it so the low-friction path
# actually exists. The location is deliberately `global`: every regional gemini endpoint 404s.
ENV_VARS="${ENV_VARS},VERTEX_PROJECT=${PROJECT}"
ENV_VARS="${ENV_VARS},VERTEX_LOCATION=global"
if [[ "$ATTACH_CLOUD_SQL" == "1" ]]; then
  ENV_VARS="${ENV_VARS},RIA_DB_ENABLED=${DB_ENABLED}"
  ENV_VARS="${ENV_VARS},RIA_DB_HOST=/cloudsql/${INSTANCE_CONNECTION_NAME}"
  ENV_VARS="${ENV_VARS},RIA_DB_PORT=${DB_PORT}"
  ENV_VARS="${ENV_VARS},RIA_DB_NAME=${DB_NAME}"
  ENV_VARS="${ENV_VARS},RIA_DB_USER=${DB_USER}"
else
  # Supported standalone mode: phone -> firm resolves live from Google Places + SEC IAPD.
  ENV_VARS="${ENV_VARS},RIA_DB_ENABLED=off"
fi

DEPLOY_ARGS=(
  run deploy "$SERVICE"
  --project "$PROJECT"
  --region "$REGION"
  --image "${IMAGE}:${TAG}"
  --platform managed
  --port 8080
  --service-account "$RUNTIME_SA"

  # --- cost shape: scale to zero, capped at the top end ---
  --min-instances "$MIN_INSTANCES"
  --max-instances "$MAX_INSTANCES"
  --concurrency "$CONCURRENCY"
  --cpu "$CPU"
  --memory "$MEMORY"
  --cpu-throttling
  --cpu-boost
  --timeout "$TIMEOUT"

  # --- runtime secrets (resolved by Cloud Run, never by this script) ---
  --set-secrets "RIA_IDENTITY_API_KEY=${SECRET_API_KEY}:latest,RIA_DB_PASSWORD=${SECRET_DB_PASSWORD}:latest,PLACES_API_KEY=${SECRET_PLACES_API_KEY}:latest"

  # --- plain env (built above) ---
  --set-env-vars "$ENV_VARS"

  --ingress all
  --quiet
)
# Cloud SQL over the mounted unix socket. ADD, not SET, so it cannot drop an instance someone
# else attached to this service.
if [[ "$ATTACH_CLOUD_SQL" == "1" ]]; then
  DEPLOY_ARGS+=(--add-cloudsql-instances "$INSTANCE_CONNECTION_NAME")
fi
if [[ "$ALLOW_UNAUTHENTICATED" == "1" ]]; then
  DEPLOY_ARGS+=(--allow-unauthenticated)
else
  # IAM-gated instead: callers need roles/run.invoker and an identity token.
  DEPLOY_ARGS+=(--no-allow-unauthenticated)
fi
mutate gcloud "${DEPLOY_ARGS[@]}"

# --- 7. verify ------------------------------------------------------------------------------
say "Verify"
URL="$(q 'https://ria-identity-api-<hash>-uc.a.run.app' gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo "  url: $URL"
if [[ "$DRY_RUN" != "1" ]]; then
  # Never index status.traffic[0] — tagged revisions occupy the first slots and the entry
  # actually serving 100% can be last (scripts/safe-changes R8). Select by percent.
  gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format=json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
      const live=(j.status.traffic||[]).find(t=>t.percent===100);
      console.log('  serving:',live&&live.revisionName,'@',(live&&live.percent)+'%');
      console.log('  latest :',j.status.latestReadyRevisionName);
      console.log(live&&live.revisionName===j.status.latestReadyRevisionName?'  IN SYNC':'  *** NOT SERVING LATEST ***')})" || true
  # /health is open by design — no key needed, and it reports the database honestly rather than
  # failing when Cloud SQL is unreachable.
  curl -fsS -m 30 "$URL/health" \
    | (command -v jq >/dev/null 2>&1 && jq '{ok, db: .sources.formAdvDb.reachable, dbHost: .sources.formAdvDb.host, places: .sources.places.configured, ageDays: .freshness.ageDays, stale: .freshness.stale, hints}' || cat) \
    || echo "  /health did not answer — run scripts/cloudrun/smoke-cloudrun.sh for detail"
fi

if [[ "$DRY_RUN" != "1" ]]; then
  mkdir -p outputs
  cat > outputs/cloudrun-deployment.json <<EOF
{ "project": "$PROJECT", "region": "$REGION", "service": "$SERVICE",
  "image": "${IMAGE}:${TAG}", "url": "$URL", "health": "$URL/health",
  "runtimeServiceAccount": "$RUNTIME_SA",
  "scaling": { "minInstances": $MIN_INSTANCES, "maxInstances": $MAX_INSTANCES, "concurrency": $CONCURRENCY,
               "dailyLookupCapPerInstance": $DAILY_LOOKUP_CAP, "dailyLookupCapFleet": $((DAILY_LOOKUP_CAP * MAX_INSTANCES)) },
  "cloudSql": { "instance": "$INSTANCE_CONNECTION_NAME", "socket": "/cloudsql/$INSTANCE_CONNECTION_NAME", "port": $DB_PORT, "database": "$DB_NAME" },
  "secrets": { "apiKey": "$SECRET_API_KEY", "dbPassword": "$SECRET_DB_PASSWORD", "placesApiKey": "$SECRET_PLACES_API_KEY" },
  "example": "$URL/v1/claim/lookup?phone=814-238-6249" }
EOF
fi

echo
echo "Deployed (scale to zero: min-instances=$MIN_INSTANCES)."
echo "  endpoint : $URL"
echo "  health   : curl $URL/health"
echo "  lookup   : curl -N -H 'Authorization: Bearer <key>' '$URL/v1/claim/lookup?phone=814-238-6249'"
echo "  smoke    : ./scripts/cloudrun/smoke-cloudrun.sh"
echo "  logs     : gcloud run services logs read $SERVICE --project $PROJECT --region $REGION --limit 50"
echo
echo "  The VM path is untouched and still deployable: ./scripts/gcp-vm/deploy-gcp-vm.sh"
