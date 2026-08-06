#!/usr/bin/env bash
# Deploy the RIA Identity API to its own VM (Node + Caddy TLS via sslip.io).
#
# Same shape as the brokercheck-api / insurance-agents-api deploys, PLUS the things this
# service needs that they do not:
#
#   * CLOUD SQL AUTH PROXY, as a sibling systemd unit. The service reads the LIVE Form ADV
#     firm table (`ria.firms` on hushh-tech-prod:us-central1:hushh-directories-db) — there is
#     no on-disk index any more — and it only ever talks to a loopback port, so a raw database
#     IP never appears in any config.
#   * TWO EXTRA SECRETS, both PRE-EXISTING AND SHARED. They are read at deploy time and never
#     created, never rotated, never printed:
#       directories-db-password        the `directories` Postgres user (shared with
#                                      ria-directory and the rest of the directories fleet)
#       hotel-scraper-places-api-key   the Google Places (New) key (shared with hotel-scraper)
#     Rotating either here would break another service. See scripts/safe-changes.
#   * roles/cloudsql.client on the VM service account (plus secretAccessor). Granted
#     additively below with add-iam-policy-binding — never set-iam-policy.
#
# The ONE secret this deploy owns is our own bearer key:
#   ria-identity-api-key   gates /v1/*. Auto-created (random 32-byte hex) if absent.
#
# THE PROXY IS `Wants=`, NOT `Requires=`. config.mjs is explicit that a database which will
# not answer is not fatal at boot: the Google Places path can still resolve a phone on its
# own and /health reports the reachability honestly. `Requires=` would turn a proxy restart
# into a full outage.
set -euo pipefail

PROJECT="${PROJECT:-hushh-tech-prod}"
ZONE="${ZONE:-us-central1-c}"
REGION="${REGION:-${ZONE%-*}}"
VM_NAME="${VM_NAME:-ria-identity-api-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
STATIC_IP_NAME="${STATIC_IP_NAME:-ria-identity-api-ip}"
NETWORK_TAG="${NETWORK_TAG:-ria-identity-api}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"   # empty = the project's default compute SA

# Our bearer key. Auto-created if it does not exist yet.
SECRET_API_KEY="${SECRET_API_KEY:-ria-identity-api-key}"

# SHARED, PRE-EXISTING secrets. Read-only here. Do NOT add a create-if-missing branch to
# either of these: minting a new value would hand this service a password/key that the
# service actually holding the resource does not have.
SECRET_DB_PASSWORD="${SECRET_DB_PASSWORD:-directories-db-password}"
SECRET_PLACES_API_KEY="${SECRET_PLACES_API_KEY:-hotel-scraper-places-api-key}"

# Cloud SQL (Postgres 16, shared directories instance).
INSTANCE_CONNECTION_NAME="${INSTANCE_CONNECTION_NAME:-hushh-tech-prod:us-central1:hushh-directories-db}"
CLOUD_SQL_PROXY_VERSION="${CLOUD_SQL_PROXY_VERSION:-v2.14.1}"

# Loopback port the proxy listens on. 5439 is config.mjs's RIA_DB_PORT default, deliberately
# NOT 5432 — so a stray local Postgres cannot be mistaken for the Cloud SQL instance.
DB_PORT="${DB_PORT:-5439}"
DB_NAME="${DB_NAME:-ria}"
DB_USER="${DB_USER:-directories}"

[[ -z "$PROJECT" ]] && { echo "PROJECT is required." >&2; exit 1; }
[[ -z "$INSTANCE_CONNECTION_NAME" ]] && { echo "INSTANCE_CONNECTION_NAME is required (project:region:instance)." >&2; exit 1; }

# Run from the service root whatever directory the caller is sitting in — the tar below is
# relative, and shipping the wrong tree is a genuinely confusing failure.
SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$SERVICE_DIR"
[[ -f server.mjs ]] || { echo "server.mjs not found in $SERVICE_DIR — wrong directory?" >&2; exit 1; }

echo "Deploying $VM_NAME to $PROJECT/$ZONE (from $SERVICE_DIR)"

# --- secrets -------------------------------------------------------------------------------
# Values are captured into variables and written straight into a 0600 env file. Nothing here
# is echoed, and nothing is passed on a command line where `ps` could read it.
fetch_secret() {
  local name="$1" val
  if ! val="$(gcloud secrets versions access latest --secret "$name" --project "$PROJECT" 2>/dev/null)"; then
    echo "Missing Secret Manager secret: $name (this deploy does not create it — it is shared)." >&2
    exit 1
  fi
  printf '%s' "$val"
}

if ! API_KEY="$(gcloud secrets versions access latest --secret "$SECRET_API_KEY" --project "$PROJECT" 2>/dev/null)"; then
  echo "Creating $SECRET_API_KEY (random 32-byte hex)…"
  API_KEY="$(openssl rand -hex 32)"
  printf '%s' "$API_KEY" | gcloud secrets create "$SECRET_API_KEY" --data-file=- --replication-policy=automatic --project "$PROJECT"
fi

echo "Fetching shared secrets (values are never printed)…"
DB_PASSWORD="$(fetch_secret "$SECRET_DB_PASSWORD")"
PLACES_API_KEY="$(fetch_secret "$SECRET_PLACES_API_KEY")"

# --- IAM for the VM service account --------------------------------------------------------
# Additive bindings only. cloudsql.client is what lets the Auth Proxy open a connection;
# secretAccessor is not used at runtime today (secrets are baked into the env file) but is
# what a future secret-mount would need, and both are already held by the directories fleet.
VM_SA="$SERVICE_ACCOUNT"
if [[ -z "$VM_SA" ]]; then
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  VM_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
echo "VM service account: $VM_SA"
for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${VM_SA}" --role "$ROLE" \
    --condition=None --quiet >/dev/null
done

# --- static IP + firewall ------------------------------------------------------------------
gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || gcloud compute addresses create "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION"
STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION" --format='value(address)')"
API_HOST="ria-identity.${STATIC_IP}.sslip.io"
echo "Static IP: $STATIC_IP  ->  https://$API_HOST"

gcloud compute firewall-rules describe "${NETWORK_TAG}-https" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute firewall-rules create "${NETWORK_TAG}-https" --project "$PROJECT" \
       --allow tcp:80,tcp:443 --target-tags "$NETWORK_TAG" --source-ranges 0.0.0.0/0 \
       --description "Public HTTPS for the RIA Identity API"

# --- instance ------------------------------------------------------------------------------
if ! gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
  CREATE_ARGS=(
    --project "$PROJECT" --zone "$ZONE" --machine-type "$MACHINE_TYPE"
    --image-family debian-12 --image-project debian-cloud
    --boot-disk-size 20GB --address "$STATIC_IP" --tags "$NETWORK_TAG"
    --scopes "https://www.googleapis.com/auth/cloud-platform"
  )
  [[ -n "$SERVICE_ACCOUNT" ]] && CREATE_ARGS+=(--service-account "$SERVICE_ACCOUNT")
  gcloud compute instances create "$VM_NAME" "${CREATE_ARGS[@]}"
else
  gcloud compute instances add-tags "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --tags "$NETWORK_TAG" >/dev/null 2>&1 || true
fi

echo "Waiting for SSH..."
for i in $(seq 1 30); do
  gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "true" >/dev/null 2>&1 && break
  [[ $i -eq 30 ]] && { echo "SSH not ready after ~5min" >&2; exit 1; }
  sleep 10
done

# --- ship code -----------------------------------------------------------------------------
ARCHIVE="/tmp/husshone-ria-identity.tgz"
tar --exclude='./node_modules' --exclude='./outputs' --exclude='./.git' -czf "$ARCHIVE" .
gcloud compute scp "$ARCHIVE" "$VM_NAME:/tmp/husshone-ria-identity.tgz" --project "$PROJECT" --zone "$ZONE" >/dev/null

# NOTE ON HEREDOCS: the outer heredoc is UNQUOTED, so ${API_HOST}, ${DB_PORT},
# ${INSTANCE_CONNECTION_NAME} and ${CLOUD_SQL_PROXY_VERSION} are substituted HERE, locally,
# even where they sit inside a nested <<'UNIT'. That is intentional. Anything that must stay
# literal on the VM is escaped as \$.
REMOTE="$(mktemp)"
cat > "$REMOTE" <<REMOTE_EOF
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https jq

# Node 22 (the service uses top-level await and node:test). Debian 12 ships v18.
if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy
fi

# Cloud SQL Auth Proxy v2, pinned.
if [[ ! -x /usr/local/bin/cloud-sql-proxy ]]; then
  sudo curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${CLOUD_SQL_PROXY_VERSION}/cloud-sql-proxy.linux.amd64"
  sudo chmod +x /usr/local/bin/cloud-sql-proxy
fi

id ria-identity >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /var/lib/ria-identity --shell /usr/sbin/nologin ria-identity
sudo mkdir -p /opt/husshone-ria-identity /var/lib/ria-identity
sudo rm -rf /opt/husshone-ria-identity/*
sudo tar -xzf /tmp/husshone-ria-identity.tgz -C /opt/husshone-ria-identity
sudo chown -R ria-identity:ria-identity /opt/husshone-ria-identity /var/lib/ria-identity

# The only runtime dependency is \`pg\`. No lockfile is committed, so npm ci falls back.
cd /opt/husshone-ria-identity
sudo -u ria-identity npm ci --omit=dev 2>/dev/null || sudo -u ria-identity npm install --omit=dev --no-audit --no-fund

sudo tee /etc/systemd/system/cloud-sql-proxy.service >/dev/null <<'UNIT'
[Unit]
Description=Cloud SQL Auth Proxy (ria / hushh-directories-db)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ria-identity
Group=ria-identity
ExecStart=/usr/local/bin/cloud-sql-proxy --address 127.0.0.1 --port ${DB_PORT} ${INSTANCE_CONNECTION_NAME}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

# Wants=, not Requires=: the API must still boot (and still answer /health honestly, and
# still serve the live Google Places -> IAPD path) when the database is unreachable.
sudo tee /etc/systemd/system/ria-identity-api.service >/dev/null <<'UNIT'
[Unit]
Description=RIA Identity API (phone -> firm -> claim your profile)
After=network-online.target cloud-sql-proxy.service
Wants=network-online.target cloud-sql-proxy.service

[Service]
Type=simple
User=ria-identity
Group=ria-identity
WorkingDirectory=/opt/husshone-ria-identity
EnvironmentFile=/etc/ria-identity.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/ria-identity

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${API_HOST} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
		transport http {
			response_header_timeout 5m
		}
	}
}
CADDY
REMOTE_EOF
gcloud compute scp "$REMOTE" "$VM_NAME:/tmp/ria-identity-remote-setup.sh" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$REMOTE"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "bash /tmp/ria-identity-remote-setup.sh"

# --- env file (secrets injected here, moved into place at 0600) -----------------------------
umask 077
ENV_TMP="$(mktemp)"
cat > "$ENV_TMP" <<EOF
PORT=8080
NODE_ENV=production

# Our bearer key. Once this is set the service fails CLOSED on /v1/*.
RIA_IDENTITY_API_KEY=$API_KEY

# Cloud SQL, through the Auth Proxy on loopback. Never a raw instance IP.
RIA_DB_HOST=127.0.0.1
RIA_DB_PORT=$DB_PORT
RIA_DB_NAME=$DB_NAME
RIA_DB_USER=$DB_USER
RIA_DB_PASSWORD=$DB_PASSWORD

# Google Places (New). Live cross-check only — of everything it returns, ONLY placeId may
# ever be persisted (Google Maps Platform terms; see scripts/lib/places.mjs).
PLACES_API_KEY=$PLACES_API_KEY

# One trusted hop: Caddy on this VM, which appends the real client to X-Forwarded-For.
# The rate limit and the daily cap read the RIGHTMOST entry because of it.
TRUSTED_PROXY_COUNT=1

CACHE_SNAPSHOT_PATH=/var/lib/ria-identity/cache-snapshot.json
CACHE_SNAPSHOT_INTERVAL_MS=300000
EOF
gcloud compute scp "$ENV_TMP" "$VM_NAME:/tmp/ria-identity.env" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$ENV_TMP"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo mv /tmp/ria-identity.env /etc/ria-identity.env && sudo chown root:root /etc/ria-identity.env && sudo chmod 600 /etc/ria-identity.env"

# --- enable + start ------------------------------------------------------------------------
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
  set -e
  sudo systemctl daemon-reload
  sudo systemctl enable --now cloud-sql-proxy.service
  sleep 3
  sudo systemctl enable --now ria-identity-api.service
  sudo systemctl restart ria-identity-api.service
  sudo systemctl enable --now caddy
  sudo systemctl reload caddy || sudo systemctl restart caddy
  sleep 3
  echo '-- /health --'
  curl -fsS http://127.0.0.1:8080/health | jq '{ok, formAdv: .sources.formAdvDb.reachable, places: .sources.places.configured, ageDays: .freshness.ageDays, stale: .freshness.stale, hints}' \
    || echo 'LOCAL HEALTH FAILED'
"

mkdir -p outputs
cat > outputs/vm-deployment.json <<EOF
{ "project": "$PROJECT", "zone": "$ZONE", "vm": "$VM_NAME", "staticIp": "$STATIC_IP",
  "endpoint": "https://$API_HOST", "health": "https://$API_HOST/health",
  "cloudSql": "$INSTANCE_CONNECTION_NAME", "dbPort": $DB_PORT,
  "secrets": { "apiKey": "$SECRET_API_KEY", "dbPassword": "$SECRET_DB_PASSWORD", "placesApiKey": "$SECRET_PLACES_API_KEY" },
  "example": "https://$API_HOST/v1/claim/lookup?phone=814-238-6249" }
EOF

echo
echo "Deployed. Endpoint: https://$API_HOST"
echo "  health : curl https://$API_HOST/health"
echo "  lookup : curl -N -H 'Authorization: Bearer <key>' 'https://$API_HOST/v1/claim/lookup?phone=814-238-6249'"
echo "  smoke  : ./scripts/gcp-vm/test-vm-api.sh"
echo "  (First TLS handshake provisions the cert; allow ~30s.)"
echo
echo "  proxy  : gcloud compute ssh $VM_NAME --zone $ZONE --command 'sudo systemctl status cloud-sql-proxy --no-pager'"
echo "  logs   : gcloud compute ssh $VM_NAME --zone $ZONE --command 'sudo journalctl -u ria-identity-api -f'"
