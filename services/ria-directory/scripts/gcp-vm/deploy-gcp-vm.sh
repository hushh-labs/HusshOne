#!/usr/bin/env bash
# Deploy the US RIA directory to a VM in the directories fleet. Mirrors the
# hotel-scraper deploy, MINUS the Places/OSM stack (this is a bulk registry
# ingest, not a per-ZIP crawl), PLUS: Cloud SQL Auth Proxy, a 24/7 worker unit,
# a daily report timer, and first-boot init (schema + ZIP geo-reference load).
#
# The worker (worker.mjs) discovers + downloads + stream-ingests the newest SEC
# Form ADV / IAPD compilation feeds (firms + individuals) on start, then re-checks
# monthly. The API binds to loopback only — there is NO public firewall rule.
# Reach /status or /run via `scripts/gcp-vm/test-vm-api.sh` (SSH-side curl).
#
# Prerequisites (one-time, see README.md "Cloud SQL setup"):
#   - A Cloud SQL Postgres instance with database `ria`, user `directories`, and
#     the postgis extension available (shared hushh-directories-db instance).
#   - Secret Manager secrets (names overridable below):
#       ria-db-password                   -> the `directories` DB password
#       hushh-tech-gmail-user             -> Gmail SMTP username (shared)
#       hushh-tech-gmail-app-password     -> Gmail SMTP app password (shared)
#   - The VM service account has roles/cloudsql.client + roles/secretmanager.secretAccessor.
#
# Required env: INSTANCE_CONNECTION_NAME=project:region:instance (defaulted below).
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
REGION="${REGION:-${ZONE%-*}}"
VM_NAME="${VM_NAME:-ria-directory-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
STATIC_IP_NAME="${STATIC_IP_NAME:-ria-directory-ip}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"   # empty = project default compute SA
API_KEY_FILE="${API_KEY_FILE:-$PWD/secrets/vm-api-key}"

# Shared directories Cloud SQL instance (Postgres + PostGIS).
INSTANCE_CONNECTION_NAME="${INSTANCE_CONNECTION_NAME:-hushh-tech-prod:us-central1:hushh-directories-db}"

# Secret Manager secret names (values are fetched at deploy time, never printed).
SECRET_DB_PASSWORD="${SECRET_DB_PASSWORD:-directories-db-password}"
# Gmail SMTP app-password mechanism (shared hushh-tech Gmail creds).
SECRET_GMAIL_USER="${SECRET_GMAIL_USER:-hushh-tech-gmail-user}"
SECRET_GMAIL_APP_PASSWORD="${SECRET_GMAIL_APP_PASSWORD:-hushh-tech-gmail-app-password}"

# Non-secret app config.
PGDATABASE="${PGDATABASE:-ria}"
PGUSER="${PGUSER:-directories}"
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

# Reserve a static IP (stable egress; keeps the SEC download source predictable and
# lets us request an allowlist bump if the datacenter IP ever gets rate-limited).
if ! gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION"
fi
STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION" --format='value(address)')"

# Create the instance if absent. cloud-platform scope lets the VM SA reach Cloud
# SQL + Secret Manager. NO public firewall rule is created (API is loopback-only).
if ! gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
  CREATE_ARGS=(
    --project "$PROJECT" --zone "$ZONE" --machine-type "$MACHINE_TYPE"
    --image-family debian-12 --image-project debian-cloud
    --boot-disk-size 30GB --address "$STATIC_IP"
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

ARCHIVE="/tmp/husshone-ria-directory-vm.tgz"
tar \
  --exclude='./node_modules' \
  --exclude='./secrets' \
  --exclude='./outputs' \
  --exclude='./logs' \
  --exclude='./.git' \
  -czf "$ARCHIVE" .
gcloud compute scp "$ARCHIVE" "$VM_NAME:/tmp/husshone-ria-directory-vm.tgz" --project "$PROJECT" --zone "$ZONE" >/dev/null

# --- Remote setup: packages, user, code, proxy binary, GeoNames, units --------
REMOTE_SCRIPT="$(mktemp)"
cat > "$REMOTE_SCRIPT" <<REMOTE
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg nodejs npm jq unzip

# Cloud SQL Auth Proxy v2 (pinned).
if [[ ! -x /usr/local/bin/cloud-sql-proxy ]]; then
  sudo curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${CLOUD_SQL_PROXY_VERSION}/cloud-sql-proxy.linux.amd64"
  sudo chmod +x /usr/local/bin/cloud-sql-proxy
fi

if ! id ria-directory >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir /var/lib/ria-directory --shell /usr/sbin/nologin ria-directory
fi

sudo mkdir -p /opt/husshone-ria-directory /var/lib/ria-directory/outputs
sudo tar -xzf /tmp/husshone-ria-directory-vm.tgz -C /opt/husshone-ria-directory
sudo chown -R ria-directory:ria-directory /opt/husshone-ria-directory /var/lib/ria-directory

cd /opt/husshone-ria-directory
sudo -u ria-directory npm ci --omit=dev || sudo -u ria-directory npm install --omit=dev

# GeoNames US ZIP export -> inputs/US.txt (Node has no built-in unzip). This is the
# geo-reference table firms/advisers are geo-tagged against; it is NOT a crawl queue.
if [[ ! -s /opt/husshone-ria-directory/inputs/US.txt ]]; then
  curl -fsSL -o /tmp/US.zip https://download.geonames.org/export/zip/US.zip
  sudo -u ria-directory unzip -o /tmp/US.zip US.txt -d /opt/husshone-ria-directory/inputs/
fi

# --- systemd units that need no interpolation ---
sudo tee /etc/systemd/system/ria-directory-init.service >/dev/null <<'UNIT'
[Unit]
Description=RIA directory init (schema + ZIP geo-reference load)
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=ria-directory
Group=ria-directory
WorkingDirectory=/opt/husshone-ria-directory
EnvironmentFile=/etc/ria-directory.env
ExecStart=/usr/bin/node scripts/apply-schema.mjs
ExecStart=/usr/bin/node scripts/load-zips.mjs
TimeoutStartSec=1200

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/ria-directory-worker.service >/dev/null <<'UNIT'
[Unit]
Description=RIA directory 24/7 Form ADV ingest worker
After=network-online.target cloud-sql-proxy.service ria-directory-init.service
Requires=cloud-sql-proxy.service ria-directory-init.service

[Service]
Type=simple
User=ria-directory
Group=ria-directory
WorkingDirectory=/opt/husshone-ria-directory
EnvironmentFile=/etc/ria-directory.env
ExecStart=/usr/bin/node worker.mjs
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/ria-directory-api.service >/dev/null <<'UNIT'
[Unit]
Description=RIA directory control/health API (loopback)
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=simple
User=ria-directory
Group=ria-directory
WorkingDirectory=/opt/husshone-ria-directory
EnvironmentFile=/etc/ria-directory.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/ria-directory-report.service >/dev/null <<'UNIT'
[Unit]
Description=RIA directory daily progress email
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=oneshot
User=ria-directory
Group=ria-directory
WorkingDirectory=/opt/husshone-ria-directory
EnvironmentFile=/etc/ria-directory.env
ExecStart=/usr/bin/node scripts/report.mjs
UNIT

sudo tee /etc/systemd/system/ria-directory-report.timer >/dev/null <<'UNIT'
[Unit]
Description=Run the RIA directory progress email daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
UNIT
REMOTE

gcloud compute scp "$REMOTE_SCRIPT" "$VM_NAME:/tmp/husshone-ria-directory-remote-setup.sh" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$REMOTE_SCRIPT"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "bash /tmp/husshone-ria-directory-remote-setup.sh"

# --- cloud-sql-proxy unit (needs the instance connection name interpolated) ---
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo tee /etc/systemd/system/cloud-sql-proxy.service >/dev/null" <<UNIT
[Unit]
Description=Cloud SQL Auth Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ria-directory
Group=ria-directory
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
OUTPUT_DIR=/var/lib/ria-directory/outputs
SEC_DOWNLOAD_DIR=/var/lib/ria-directory/outputs
GMAIL_USER=$GMAIL_USER
GMAIL_APP_PASSWORD=$GMAIL_APP_PASSWORD
GMAIL_SENDER_EMAIL=$GMAIL_SENDER_EMAIL
GMAIL_FROM_NAME=Hushh RIA Directory
REPORT_RECIPIENTS=$REPORT_RECIPIENTS
EOF
gcloud compute scp "$ENV_TMP" "$VM_NAME:/tmp/ria-directory.env" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$ENV_TMP"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo mv /tmp/ria-directory.env /etc/ria-directory.env && sudo chown root:root /etc/ria-directory.env && sudo chmod 600 /etc/ria-directory.env"

# --- enable + start everything ---
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
  set -e
  sudo systemctl daemon-reload
  sudo systemctl enable --now cloud-sql-proxy.service
  sleep 3
  sudo systemctl enable --now ria-directory-init.service        # schema + ZIP load (blocks ~seconds)
  sudo systemctl enable --now ria-directory-worker.service ria-directory-api.service
  # Combined hourly roll-up email is owned by social-circles-directory-vm. Keep this
  # vertical's report unit installed for manual/on-demand runs, but do NOT enable its
  # timer — otherwise recipients would get 5 emails/hour instead of one combined one.
  sudo systemctl disable ria-directory-report.timer 2>/dev/null || true
  sudo systemctl restart ria-directory-worker.service ria-directory-api.service
"

EXTERNAL_IP="$(gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"

cat > outputs/vm-deployment.json <<EOF
{
  "project": "$PROJECT",
  "zone": "$ZONE",
  "vm": "$VM_NAME",
  "staticIp": "$STATIC_IP",
  "externalIp": "$EXTERNAL_IP",
  "cloudSql": "$INSTANCE_CONNECTION_NAME",
  "apiKeyFile": "$API_KEY_FILE",
  "note": "API is loopback-only; use scripts/gcp-vm/test-vm-api.sh for /health + /status",
  "statusCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE --command 'sudo systemctl status ria-directory-worker --no-pager'",
  "logsCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE --command 'sudo journalctl -u ria-directory-worker -f'"
}
EOF

echo "VM deployed."
echo "Static (egress) IP: $STATIC_IP"
echo "Worker logs: gcloud compute ssh $VM_NAME --zone $ZONE --command 'sudo journalctl -u ria-directory-worker -f'"
echo "Health/status: scripts/gcp-vm/test-vm-api.sh"
echo "Deployment summary: outputs/vm-deployment.json"
