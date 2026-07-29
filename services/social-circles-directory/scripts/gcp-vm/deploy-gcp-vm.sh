#!/usr/bin/env bash
# Deploy the social-circles graph builder to a VM in the directories fleet. Mirrors
# the hotel-scraper deploy (Cloud SQL Auth Proxy + a 24/7 worker + a control API +
# a daily report timer + first-boot init) MINUS the crawler bits (no Places key, no
# OSM/ZIP bulk load): this service only builds a graph over the OTHER directory DBs.
#
# The API binds to loopback only — there is NO public firewall rule. Reach /status
# or /run via `scripts/gcp-vm/test-vm-api.sh` (SSH-side curl).
#
# Prerequisites (one-time):
#   - A Cloud SQL Postgres instance with database `social`, user `directories`, and
#     read access from that user to the four SOURCE databases on the SAME instance
#     (healthcare, ria, insurance, hotel_scraper). Postgres can't cross-DB query, so
#     the builder opens one proxy connection per database — all via the one proxy.
#   - Secret Manager secrets (names overridable below):
#       directories-db-password           -> the `directories` DB-user password
#       hushh-tech-gmail-user             -> Gmail SMTP username (shared)
#       hushh-tech-gmail-app-password     -> Gmail SMTP app password (shared)
#   - The VM service account has roles/cloudsql.client + roles/secretmanager.secretAccessor.
#
# Required env: INSTANCE_CONNECTION_NAME=project:region:instance (default below).
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
REGION="${REGION:-${ZONE%-*}}"
VM_NAME="${VM_NAME:-social-circles-directory-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"   # empty = project default compute SA
API_KEY_FILE="${API_KEY_FILE:-$PWD/secrets/vm-api-key}"

# The shared directories Cloud SQL instance (holds `social` + the four source DBs).
INSTANCE_CONNECTION_NAME="${INSTANCE_CONNECTION_NAME:-hushh-tech-prod:us-central1:hushh-directories-db}"

# Secret Manager secret names (values are fetched at deploy time, never printed).
SECRET_DB_PASSWORD="${SECRET_DB_PASSWORD:-directories-db-password}"
# Gmail SMTP app-password mechanism (shared hushh-tech Gmail creds).
SECRET_GMAIL_USER="${SECRET_GMAIL_USER:-hushh-tech-gmail-user}"
SECRET_GMAIL_APP_PASSWORD="${SECRET_GMAIL_APP_PASSWORD:-hushh-tech-gmail-app-password}"

# Non-secret app config.
PGDATABASE="${PGDATABASE:-social}"
PGUSER="${PGUSER:-directories}"
# The four SOURCE database names on the same instance (positional CSV; see config.mjs).
SOURCE_DBS="${SOURCE_DBS:-healthcare,ria,insurance,hotel_scraper}"
# Leave empty to send as the authenticated Gmail user (Gmail rejects a MAIL FROM that
# is not the user or a verified alias); set only to a configured send-as alias.
GMAIL_SENDER_EMAIL="${GMAIL_SENDER_EMAIL:-}"
REPORT_RECIPIENTS="${REPORT_RECIPIENTS:-ankit@hushh.ai,manish@hushh.ai,kushal@hushh.ai}"
CLOUD_SQL_PROXY_VERSION="${CLOUD_SQL_PROXY_VERSION:-v2.14.1}"

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is required. Set PROJECT or gcloud config set project <id>." >&2
  exit 1
fi
if [[ -z "${INSTANCE_CONNECTION_NAME}" ]]; then
  echo "INSTANCE_CONNECTION_NAME is required (project:region:instance)." >&2
  exit 1
fi

mkdir -p "$(dirname "$API_KEY_FILE")" outputs
if [[ ! -s "$API_KEY_FILE" ]]; then
  umask 077
  openssl rand -hex 32 > "$API_KEY_FILE"
fi
API_KEY="$(tr -d '\n' < "$API_KEY_FILE")"

echo "Fetching secrets from Secret Manager (values are not printed)..."
fetch_secret() {
  local name="$1"
  local val
  if ! val="$(gcloud secrets versions access latest --secret "$name" --project "$PROJECT" 2>/dev/null)"; then
    echo "Missing Secret Manager secret: $name" >&2
    exit 1
  fi
  printf '%s' "$val"
}
PGPASSWORD="$(fetch_secret "$SECRET_DB_PASSWORD")"
GMAIL_USER="$(fetch_secret "$SECRET_GMAIL_USER")"
GMAIL_APP_PASSWORD="$(fetch_secret "$SECRET_GMAIL_APP_PASSWORD")"

echo "Using project=$PROJECT zone=$ZONE vm=$VM_NAME cloudsql=$INSTANCE_CONNECTION_NAME"

# Create the instance if absent. cloud-platform scope lets the VM SA reach Cloud
# SQL + Secret Manager. NO public firewall rule is created (API is loopback-only).
if ! gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
  CREATE_ARGS=(
    --project "$PROJECT" --zone "$ZONE" --machine-type "$MACHINE_TYPE"
    --image-family debian-12 --image-project debian-cloud
    --boot-disk-size 20GB
    --scopes "https://www.googleapis.com/auth/cloud-platform"
  )
  if [[ -n "$SERVICE_ACCOUNT" ]]; then CREATE_ARGS+=(--service-account "$SERVICE_ACCOUNT"); fi
  gcloud compute instances create "$VM_NAME" "${CREATE_ARGS[@]}"
fi

echo "Waiting for SSH..."
for i in $(seq 1 30); do
  if gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "true" >/dev/null 2>&1; then
    break
  fi
  if [[ $i -eq 30 ]]; then echo "SSH did not become ready after ~5min" >&2; exit 1; fi
  sleep 10
done

ARCHIVE="/tmp/husshone-social-circles-directory-vm.tgz"
tar \
  --exclude='./node_modules' \
  --exclude='./secrets' \
  --exclude='./outputs' \
  --exclude='./logs' \
  --exclude='./.git' \
  -czf "$ARCHIVE" .
gcloud compute scp "$ARCHIVE" "$VM_NAME:/tmp/husshone-social-circles-directory-vm.tgz" --project "$PROJECT" --zone "$ZONE" >/dev/null

# --- Remote setup: packages, user, code, proxy binary, units ------------------
REMOTE_SCRIPT="$(mktemp)"
cat > "$REMOTE_SCRIPT" <<REMOTE
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg nodejs npm jq

# Cloud SQL Auth Proxy v2 (pinned).
if [[ ! -x /usr/local/bin/cloud-sql-proxy ]]; then
  sudo curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${CLOUD_SQL_PROXY_VERSION}/cloud-sql-proxy.linux.amd64"
  sudo chmod +x /usr/local/bin/cloud-sql-proxy
fi

if ! id social-circles >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir /var/lib/social-circles --shell /usr/sbin/nologin social-circles
fi

sudo mkdir -p /opt/husshone-social-circles-directory /var/lib/social-circles/outputs
sudo tar -xzf /tmp/husshone-social-circles-directory-vm.tgz -C /opt/husshone-social-circles-directory
sudo chown -R social-circles:social-circles /opt/husshone-social-circles-directory /var/lib/social-circles

cd /opt/husshone-social-circles-directory
sudo -u social-circles npm ci --omit=dev || sudo -u social-circles npm install --omit=dev

# --- systemd units that need no interpolation ---
sudo tee /etc/systemd/system/social-circles-directory-init.service >/dev/null <<'UNIT'
[Unit]
Description=Social-circles graph init (apply schema to the social DB)
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=social-circles
Group=social-circles
WorkingDirectory=/opt/husshone-social-circles-directory
EnvironmentFile=/etc/social-circles-directory.env
ExecStart=/usr/bin/node scripts/apply-schema.mjs
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/social-circles-directory-worker.service >/dev/null <<'UNIT'
[Unit]
Description=Social-circles 24/7 graph builder
After=network-online.target cloud-sql-proxy.service social-circles-directory-init.service
Requires=cloud-sql-proxy.service social-circles-directory-init.service

[Service]
Type=simple
User=social-circles
Group=social-circles
WorkingDirectory=/opt/husshone-social-circles-directory
EnvironmentFile=/etc/social-circles-directory.env
ExecStart=/usr/bin/node worker.mjs
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/social-circles-directory-api.service >/dev/null <<'UNIT'
[Unit]
Description=Social-circles control/health API (loopback)
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=simple
User=social-circles
Group=social-circles
WorkingDirectory=/opt/husshone-social-circles-directory
EnvironmentFile=/etc/social-circles-directory.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/social-circles-directory-report.service >/dev/null <<'UNIT'
[Unit]
Description=Social-circles combined hourly roll-up email
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=oneshot
User=social-circles
Group=social-circles
WorkingDirectory=/opt/husshone-social-circles-directory
EnvironmentFile=/etc/social-circles-directory.env
ExecStart=/usr/bin/node scripts/report.mjs
UNIT

sudo tee /etc/systemd/system/social-circles-directory-report.timer >/dev/null <<'UNIT'
[Unit]
Description=Run the combined directories roll-up email hourly

[Timer]
OnCalendar=*:09
Persistent=true

[Install]
WantedBy=timers.target
UNIT
REMOTE

gcloud compute scp "$REMOTE_SCRIPT" "$VM_NAME:/tmp/husshone-social-circles-directory-remote-setup.sh" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$REMOTE_SCRIPT"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "bash /tmp/husshone-social-circles-directory-remote-setup.sh"

# --- cloud-sql-proxy unit (needs the instance connection name interpolated) ---
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo tee /etc/systemd/system/cloud-sql-proxy.service >/dev/null" <<UNIT
[Unit]
Description=Cloud SQL Auth Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=social-circles
Group=social-circles
ExecStart=/usr/local/bin/cloud-sql-proxy --address 127.0.0.1 --port 5432 ${INSTANCE_CONNECTION_NAME}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

# --- env file (secrets): build locally, scp, move into place (avoids shell quoting) ---
ENV_TMP="$(mktemp)"
umask 077
cat > "$ENV_TMP" <<EOF
PORT=8080
SCRAPER_API_KEY=$API_KEY
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=$PGDATABASE
PGUSER=$PGUSER
PGPASSWORD=$PGPASSWORD
SOURCE_DBS=$SOURCE_DBS
OUTPUT_DIR=/var/lib/social-circles/outputs
GMAIL_USER=$GMAIL_USER
GMAIL_APP_PASSWORD=$GMAIL_APP_PASSWORD
GMAIL_SENDER_EMAIL=$GMAIL_SENDER_EMAIL
GMAIL_FROM_NAME=Hushh Social Graph
REPORT_RECIPIENTS=$REPORT_RECIPIENTS
EOF
gcloud compute scp "$ENV_TMP" "$VM_NAME:/tmp/social-circles-directory.env" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$ENV_TMP"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo mv /tmp/social-circles-directory.env /etc/social-circles-directory.env && sudo chown root:root /etc/social-circles-directory.env && sudo chmod 600 /etc/social-circles-directory.env"

# --- enable + start everything ---
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
  set -e
  sudo systemctl daemon-reload
  sudo systemctl enable --now cloud-sql-proxy.service
  sleep 3
  sudo systemctl enable --now social-circles-directory-init.service   # apply schema (blocks ~seconds)
  sudo systemctl enable --now social-circles-directory-worker.service social-circles-directory-api.service
  sudo systemctl enable --now social-circles-directory-report.timer
  sudo systemctl restart social-circles-directory-worker.service social-circles-directory-api.service
"

EXTERNAL_IP="$(gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"

cat > outputs/vm-deployment.json <<EOF
{
  "project": "$PROJECT",
  "zone": "$ZONE",
  "vm": "$VM_NAME",
  "externalIp": "$EXTERNAL_IP",
  "cloudSql": "$INSTANCE_CONNECTION_NAME",
  "apiKeyFile": "$API_KEY_FILE",
  "note": "API is loopback-only; use scripts/gcp-vm/test-vm-api.sh for /health + /status",
  "statusCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE --command 'sudo systemctl status social-circles-directory-worker --no-pager'",
  "logsCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE --command 'sudo journalctl -u social-circles-directory-worker -f'"
}
EOF

echo "VM deployed."
echo "Worker logs: gcloud compute ssh $VM_NAME --zone $ZONE --command 'sudo journalctl -u social-circles-directory-worker -f'"
echo "Health/status: scripts/gcp-vm/test-vm-api.sh"
echo "Deployment summary: outputs/vm-deployment.json"
