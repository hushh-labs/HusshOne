#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-linkedin-scraper-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
TAG="${TAG:-linkedin-scraper-api}"
API_FIREWALL="${API_FIREWALL:-linkedin-scraper-api-8080}"
STATIC_IP_NAME="${STATIC_IP_NAME:-linkedin-scraper-ip}"
API_KEY_FILE="${API_KEY_FILE:-$PWD/secrets/vm-api-key}"

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is required. Set PROJECT or gcloud config set project <id>." >&2
  exit 1
fi

mkdir -p "$(dirname "$API_KEY_FILE")" outputs
if [[ ! -s "$API_KEY_FILE" ]]; then
  umask 077
  openssl rand -hex 32 > "$API_KEY_FILE"
fi
API_KEY="$(tr -d '\n' < "$API_KEY_FILE")"

echo "Using project=$PROJECT zone=$ZONE vm=$VM_NAME"

if ! gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "${ZONE%-*}" >/dev/null 2>&1; then
  gcloud compute addresses create "$STATIC_IP_NAME" \
    --project "$PROJECT" \
    --region "${ZONE%-*}"
fi
STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "${ZONE%-*}" --format='value(address)')"

if ! gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" \
    --project "$PROJECT" \
    --zone "$ZONE" \
    --machine-type "$MACHINE_TYPE" \
    --image-family debian-12 \
    --image-project debian-cloud \
    --boot-disk-size 30GB \
    --address "$STATIC_IP" \
    --tags "$TAG"
else
  gcloud compute instances add-tags "$VM_NAME" \
    --project "$PROJECT" \
    --zone "$ZONE" \
    --tags "$TAG" >/dev/null
fi

if ! gcloud compute firewall-rules describe "$API_FIREWALL" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$API_FIREWALL" \
    --project "$PROJECT" \
    --allow tcp:8080 \
    --target-tags "$TAG" \
    --source-ranges 0.0.0.0/0 \
    --description "LinkedIn scraper API, protected by SCRAPER_API_KEY"
fi

echo "Waiting for SSH..."
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "true" >/dev/null

ARCHIVE="/tmp/husshone-linkedin-scraper-vm.tgz"
tar \
  --exclude='./node_modules' \
  --exclude='./.venv' \
  --exclude='./secrets' \
  --exclude='./outputs' \
  --exclude='./logs' \
  --exclude='./.git' \
  -czf "$ARCHIVE" .

gcloud compute scp "$ARCHIVE" "$VM_NAME:/tmp/husshone-linkedin-scraper-vm.tgz" \
  --project "$PROJECT" \
  --zone "$ZONE" >/dev/null

REMOTE_SCRIPT="$(mktemp)"
cat > "$REMOTE_SCRIPT" <<'REMOTE'
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg \
  chromium fonts-liberation \
  nodejs npm \
  novnc websockify x11vnc xvfb \
  jq

if ! id linkedin-scraper >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir /var/lib/linkedin-scraper --shell /usr/sbin/nologin linkedin-scraper
fi

sudo mkdir -p /opt/husshone-linkedin-scraper /var/lib/linkedin-scraper/chrome-profile /var/lib/linkedin-scraper/outputs
sudo tar -xzf /tmp/husshone-linkedin-scraper-vm.tgz -C /opt/husshone-linkedin-scraper
sudo chown -R linkedin-scraper:linkedin-scraper /opt/husshone-linkedin-scraper /var/lib/linkedin-scraper

cd /opt/husshone-linkedin-scraper
sudo -u linkedin-scraper npm ci --omit=dev

sudo tee /etc/systemd/system/linkedin-scraper-xvfb.service >/dev/null <<'UNIT'
[Unit]
Description=LinkedIn scraper virtual X display
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1365x768x24 -nolisten tcp
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/linkedin-scraper-x11vnc.service >/dev/null <<'UNIT'
[Unit]
Description=LinkedIn scraper VNC bridge
After=linkedin-scraper-xvfb.service
Requires=linkedin-scraper-xvfb.service

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :99 -localhost -rfbport 5901 -forever -shared -nopw
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/linkedin-scraper-novnc.service >/dev/null <<'UNIT'
[Unit]
Description=LinkedIn scraper noVNC web bridge
After=linkedin-scraper-x11vnc.service
Requires=linkedin-scraper-x11vnc.service

[Service]
Type=simple
ExecStart=/usr/share/novnc/utils/novnc_proxy --listen 127.0.0.1:6080 --vnc 127.0.0.1:5901
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/linkedin-scraper-api.service >/dev/null <<'UNIT'
[Unit]
Description=LinkedIn persistent Chrome scraper API
After=network-online.target linkedin-login-browser.service
Requires=linkedin-login-browser.service

[Service]
Type=simple
User=linkedin-scraper
Group=linkedin-scraper
WorkingDirectory=/opt/husshone-linkedin-scraper
EnvironmentFile=/etc/linkedin-scraper.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/linkedin-login-browser.service >/dev/null <<'UNIT'
[Unit]
Description=Manual LinkedIn login browser for persistent scraper profile
After=linkedin-scraper-xvfb.service
Requires=linkedin-scraper-xvfb.service

[Service]
Type=simple
User=linkedin-scraper
Group=linkedin-scraper
EnvironmentFile=/etc/linkedin-scraper.env
ExecStart=/usr/bin/chromium --user-data-dir=/var/lib/linkedin-scraper/chrome-profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-blink-features=AutomationControlled --start-maximized https://www.linkedin.com/feed/
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
REMOTE

gcloud compute scp "$REMOTE_SCRIPT" "$VM_NAME:/tmp/husshone-linkedin-scraper-remote-setup.sh" \
  --project "$PROJECT" \
  --zone "$ZONE" >/dev/null
rm -f "$REMOTE_SCRIPT"

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "bash /tmp/husshone-linkedin-scraper-remote-setup.sh"

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "sudo tee /etc/linkedin-scraper.env >/dev/null" <<EOF
PORT=8080
SCRAPER_API_KEY=$API_KEY
DISPLAY=:99
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_USER_DATA_DIR=/var/lib/linkedin-scraper/chrome-profile
LINKEDIN_USE_PERSISTENT_PROFILE=true
LINKEDIN_LIVE_BROWSER=true
LINKEDIN_BROWSER_URL=http://127.0.0.1:9222
LINKEDIN_PROFILE_SCRAPER_HEADLESS=false
LINKEDIN_PROFILE_SCRAPER_TIMEOUT_MS=120000
LINKEDIN_MAX_URLS_PER_REQUEST=3
OUTPUT_DIR=/var/lib/linkedin-scraper/outputs
EOF

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command \
  "sudo chown root:root /etc/linkedin-scraper.env && sudo chmod 600 /etc/linkedin-scraper.env && sudo systemctl enable --now linkedin-scraper-xvfb linkedin-scraper-x11vnc linkedin-scraper-novnc linkedin-login-browser linkedin-scraper-api && sudo systemctl restart linkedin-scraper-api"

EXTERNAL_IP="$(gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"

cat > outputs/vm-deployment.json <<EOF
{
  "project": "$PROJECT",
  "zone": "$ZONE",
  "vm": "$VM_NAME",
  "externalIp": "$EXTERNAL_IP",
  "apiUrl": "http://$EXTERNAL_IP:8080",
  "apiKeyFile": "$API_KEY_FILE",
  "novncTunnelCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE -- -N -L 6080:localhost:6080",
  "novncLocalUrl": "http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080"
}
EOF

echo "VM deployed."
echo "API: http://$EXTERNAL_IP:8080"
echo "API key file: $API_KEY_FILE"
echo "Deployment summary: outputs/vm-deployment.json"
