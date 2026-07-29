#!/usr/bin/env bash
# Deploy the US hotel crawler to a VM in the scraper fleet. Mirrors the
# instagram-scraper deploy, MINUS the browser stack (no chromium/xvfb/x11vnc/
# noVNC/login units), PLUS: Cloud SQL Auth Proxy, a 24/7 worker unit, a daily
# report timer, and first-boot init (schema + ZIP load + OSM bulk load).
#
# The API binds to loopback only — there is NO public firewall rule. Reach
# /status or /run via `scripts/gcp-vm/test-vm-api.sh` (SSH-side curl).
#
# Prerequisites (one-time, see README.md "Cloud SQL setup"):
#   - A Cloud SQL Postgres instance with database `hotel_scraper`, user
#     `hotel_scraper`, and the postgis extension available.
#   - Secret Manager secrets (names overridable below):
#       hotel-scraper-places-api-key      -> Google Places API (New) key
#       hotel-scraper-db-password         -> the hotel_scraper DB password
#       hushh-tech-gmail-user             -> Gmail SMTP username (shared)
#       hushh-tech-gmail-app-password     -> Gmail SMTP app password (shared)
#   - The VM service account has roles/cloudsql.client + roles/secretmanager.secretAccessor.
#
# Required env: INSTANCE_CONNECTION_NAME=project:region:instance
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
REGION="${REGION:-${ZONE%-*}}"
VM_NAME="${VM_NAME:-hotel-scraper-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
STATIC_IP_NAME="${STATIC_IP_NAME:-hotel-scraper-ip}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"   # empty = project default compute SA
API_KEY_FILE="${API_KEY_FILE:-$PWD/secrets/vm-api-key}"

INSTANCE_CONNECTION_NAME="${INSTANCE_CONNECTION_NAME:-hushh-tech-prod:us-central1:hushh-directories-db}"

# Secret Manager secret names (values are fetched at deploy time, never printed).
SECRET_PLACES="${SECRET_PLACES:-hotel-scraper-places-api-key}"
SECRET_DB_PASSWORD="${SECRET_DB_PASSWORD:-directories-db-password}"
# Gmail SMTP app-password mechanism (shared hushh-tech Gmail creds).
SECRET_GMAIL_USER="${SECRET_GMAIL_USER:-hushh-tech-gmail-user}"
SECRET_GMAIL_APP_PASSWORD="${SECRET_GMAIL_APP_PASSWORD:-hushh-tech-gmail-app-password}"

# Non-secret app config.
PGDATABASE="${PGDATABASE:-hotel_scraper}"
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
PLACES_API_KEY="$(fetch_secret "$SECRET_PLACES")"
PGPASSWORD="$(fetch_secret "$SECRET_DB_PASSWORD")"
GMAIL_USER="$(fetch_secret "$SECRET_GMAIL_USER")"
GMAIL_APP_PASSWORD="$(fetch_secret "$SECRET_GMAIL_APP_PASSWORD")"

echo "Using project=$PROJECT zone=$ZONE vm=$VM_NAME cloudsql=$INSTANCE_CONNECTION_NAME"

# Reserve a static IP (stable egress for Places API-key IP allowlisting).
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

ARCHIVE="/tmp/husshone-hotel-scraper-vm.tgz"
tar \
  --exclude='./node_modules' \
  --exclude='./secrets' \
  --exclude='./outputs' \
  --exclude='./logs' \
  --exclude='./.git' \
  -czf "$ARCHIVE" .
gcloud compute scp "$ARCHIVE" "$VM_NAME:/tmp/husshone-hotel-scraper-vm.tgz" --project "$PROJECT" --zone "$ZONE" >/dev/null

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

if ! id hotel-scraper >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir /var/lib/hotel-scraper --shell /usr/sbin/nologin hotel-scraper
fi

sudo mkdir -p /opt/husshone-hotel-scraper /var/lib/hotel-scraper/outputs
sudo tar -xzf /tmp/husshone-hotel-scraper-vm.tgz -C /opt/husshone-hotel-scraper
sudo chown -R hotel-scraper:hotel-scraper /opt/husshone-hotel-scraper /var/lib/hotel-scraper

cd /opt/husshone-hotel-scraper
sudo -u hotel-scraper npm ci --omit=dev || sudo -u hotel-scraper npm install --omit=dev

# GeoNames US ZIP export -> inputs/US.txt (Node has no built-in unzip).
if [[ ! -s /opt/husshone-hotel-scraper/inputs/US.txt ]]; then
  curl -fsSL -o /tmp/US.zip https://download.geonames.org/export/zip/US.zip
  sudo -u hotel-scraper unzip -o /tmp/US.zip US.txt -d /opt/husshone-hotel-scraper/inputs/
fi

# --- systemd units that need no interpolation ---
sudo tee /etc/systemd/system/hotel-scraper-init.service >/dev/null <<'UNIT'
[Unit]
Description=Hotel crawler init (schema + ZIP load)
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=hotel-scraper
Group=hotel-scraper
WorkingDirectory=/opt/husshone-hotel-scraper
EnvironmentFile=/etc/hotel-scraper.env
ExecStart=/usr/bin/node scripts/apply-schema.mjs
ExecStart=/usr/bin/node scripts/load-zips.mjs
TimeoutStartSec=1200

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/hotel-scraper-osm.service >/dev/null <<'UNIT'
[Unit]
Description=Hotel crawler OSM bulk load (free full coverage)
After=hotel-scraper-init.service
Requires=hotel-scraper-init.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=hotel-scraper
Group=hotel-scraper
WorkingDirectory=/opt/husshone-hotel-scraper
EnvironmentFile=/etc/hotel-scraper.env
ExecStart=/usr/bin/node scripts/osm-ingest.mjs
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/hotel-scraper-worker.service >/dev/null <<'UNIT'
[Unit]
Description=Hotel crawler 24/7 Places worker
After=network-online.target cloud-sql-proxy.service hotel-scraper-init.service
Requires=cloud-sql-proxy.service hotel-scraper-init.service

[Service]
Type=simple
User=hotel-scraper
Group=hotel-scraper
WorkingDirectory=/opt/husshone-hotel-scraper
EnvironmentFile=/etc/hotel-scraper.env
ExecStart=/usr/bin/node worker.mjs
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/hotel-scraper-photos.service >/dev/null <<'UNIT'
[Unit]
Description=Hotel crawler 24/7 photo resolver (Places photos)
After=network-online.target cloud-sql-proxy.service hotel-scraper-init.service
Requires=cloud-sql-proxy.service hotel-scraper-init.service

[Service]
Type=simple
User=hotel-scraper
Group=hotel-scraper
WorkingDirectory=/opt/husshone-hotel-scraper
EnvironmentFile=/etc/hotel-scraper.env
ExecStart=/usr/bin/node photos-worker.mjs
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/hotel-scraper-api.service >/dev/null <<'UNIT'
[Unit]
Description=Hotel crawler control/health API (loopback)
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=simple
User=hotel-scraper
Group=hotel-scraper
WorkingDirectory=/opt/husshone-hotel-scraper
EnvironmentFile=/etc/hotel-scraper.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/hotel-scraper-report.service >/dev/null <<'UNIT'
[Unit]
Description=Hotel crawler daily progress email
After=network-online.target cloud-sql-proxy.service
Requires=cloud-sql-proxy.service

[Service]
Type=oneshot
User=hotel-scraper
Group=hotel-scraper
WorkingDirectory=/opt/husshone-hotel-scraper
EnvironmentFile=/etc/hotel-scraper.env
ExecStart=/usr/bin/node scripts/report.mjs
UNIT

sudo tee /etc/systemd/system/hotel-scraper-report.timer >/dev/null <<'UNIT'
[Unit]
Description=Run the hotel crawler progress email daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
UNIT
REMOTE

gcloud compute scp "$REMOTE_SCRIPT" "$VM_NAME:/tmp/husshone-hotel-scraper-remote-setup.sh" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$REMOTE_SCRIPT"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "bash /tmp/husshone-hotel-scraper-remote-setup.sh"

# --- cloud-sql-proxy unit (needs the instance connection name interpolated) ---
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo tee /etc/systemd/system/cloud-sql-proxy.service >/dev/null" <<UNIT
[Unit]
Description=Cloud SQL Auth Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hotel-scraper
Group=hotel-scraper
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
PLACES_API_KEY=$PLACES_API_KEY
OUTPUT_DIR=/var/lib/hotel-scraper/outputs
GMAIL_USER=$GMAIL_USER
GMAIL_APP_PASSWORD=$GMAIL_APP_PASSWORD
GMAIL_SENDER_EMAIL=$GMAIL_SENDER_EMAIL
GMAIL_FROM_NAME=Hushh Hotel Crawler
REPORT_RECIPIENTS=$REPORT_RECIPIENTS
EOF
gcloud compute scp "$ENV_TMP" "$VM_NAME:/tmp/hotel-scraper.env" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$ENV_TMP"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo mv /tmp/hotel-scraper.env /etc/hotel-scraper.env && sudo chown root:root /etc/hotel-scraper.env && sudo chmod 600 /etc/hotel-scraper.env"

# --- enable + start everything ---
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
  set -e
  sudo systemctl daemon-reload
  sudo systemctl enable --now cloud-sql-proxy.service
  sleep 3
  # init is Type=oneshot + RemainAfterExit=yes, so 'enable --now' is a NO-OP on a
  # redeploy (the unit is already active/exited) — the schema migration would never
  # re-run. 'restart' forces ExecStart (apply-schema.mjs then load-zips.mjs) to run
  # again; it blocks until done, and 'set -e' aborts the deploy if the migration
  # fails, which is fail-safe (workers Require this unit).
  sudo systemctl enable hotel-scraper-init.service
  sudo systemctl restart hotel-scraper-init.service            # schema migration + ZIP load (blocks ~seconds)
  sudo systemctl enable hotel-scraper-osm.service
  sudo systemctl start  --no-block hotel-scraper-osm.service   # OSM bulk load runs in background
  sudo systemctl enable --now hotel-scraper-worker.service hotel-scraper-api.service hotel-scraper-photos.service
  # Combined hourly roll-up email is owned by social-circles-directory-vm. Keep this
  # vertical's report unit installed for manual/on-demand runs, but do NOT enable its
  # timer — otherwise recipients would get 5 emails/hour instead of one combined one.
  sudo systemctl disable hotel-scraper-report.timer 2>/dev/null || true
  sudo systemctl restart hotel-scraper-worker.service hotel-scraper-api.service hotel-scraper-photos.service
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
  "statusCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE --command 'sudo systemctl status hotel-scraper-worker --no-pager'",
  "logsCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE --command 'sudo journalctl -u hotel-scraper-worker -f'"
}
EOF

echo "VM deployed."
echo "Static (egress) IP: $STATIC_IP  — allowlist this on the Places API key."
echo "Worker logs: gcloud compute ssh $VM_NAME --zone $ZONE --command 'sudo journalctl -u hotel-scraper-worker -f'"
echo "Health/status: scripts/gcp-vm/test-vm-api.sh"
echo "Deployment summary: outputs/vm-deployment.json"
