#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${ZONE:-us-central1-c}"
VM_NAME="${VM_NAME:-instagram-scraper-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
TAG="${TAG:-instagram-scraper-api}"
API_FIREWALL="${API_FIREWALL:-instagram-scraper-api-8080}"
STATIC_IP_NAME="${STATIC_IP_NAME:-instagram-scraper-ip}"
API_KEY_FILE="${API_KEY_FILE:-$PWD/secrets/vm-api-key}"
# Optional residential/mobile egress proxy. Set to a full proxy URL (http://user:pass@gateway:port, incl.
# sticky-session usernames, or http://gateway:port for IP-whitelist) to route Chrome egress through it and
# bypass Instagram's datacenter-IP 429s. Empty = direct egress (unchanged behavior).
SCRAPER_PROXY_URL="${SCRAPER_PROXY_URL:-}"
SCRAPER_PROXY_LISTEN_PORT="${SCRAPER_PROXY_LISTEN_PORT:-8000}"

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
    --description "Instagram scraper API, protected by SCRAPER_API_KEY"
fi

echo "Waiting for SSH..."
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "true" >/dev/null

ARCHIVE="/tmp/husshone-instagram-scraper-vm.tgz"
tar \
  --exclude='./node_modules' \
  --exclude='./.chrome-profile' \
  --exclude='./secrets' \
  --exclude='./outputs' \
  --exclude='./logs' \
  --exclude='./.git' \
  -czf "$ARCHIVE" .

gcloud compute scp "$ARCHIVE" "$VM_NAME:/tmp/husshone-instagram-scraper-vm.tgz" \
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

if ! id instagram-scraper >/dev/null 2>&1; then
  sudo useradd --system --create-home --home-dir /var/lib/instagram-scraper --shell /usr/sbin/nologin instagram-scraper
fi

sudo mkdir -p /opt/husshone-instagram-scraper /var/lib/instagram-scraper/chrome-profile /var/lib/instagram-scraper/outputs
sudo tar -xzf /tmp/husshone-instagram-scraper-vm.tgz -C /opt/husshone-instagram-scraper
sudo chown -R instagram-scraper:instagram-scraper /opt/husshone-instagram-scraper /var/lib/instagram-scraper

cd /opt/husshone-instagram-scraper
sudo -u instagram-scraper npm ci --omit=dev
sudo chmod +x /opt/husshone-instagram-scraper/scripts/gcp-vm/start-login-browser.sh

sudo tee /etc/systemd/system/instagram-scraper-xvfb.service >/dev/null <<'UNIT'
[Unit]
Description=Instagram scraper virtual X display
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1365x900x24 -nolisten tcp
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/instagram-scraper-x11vnc.service >/dev/null <<'UNIT'
[Unit]
Description=Instagram scraper VNC bridge
After=instagram-scraper-xvfb.service
Requires=instagram-scraper-xvfb.service

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :99 -localhost -rfbport 5901 -forever -shared -nopw
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/instagram-scraper-novnc.service >/dev/null <<'UNIT'
[Unit]
Description=Instagram scraper noVNC web bridge
After=instagram-scraper-x11vnc.service
Requires=instagram-scraper-x11vnc.service

[Service]
Type=simple
ExecStart=/usr/share/novnc/utils/novnc_proxy --listen 127.0.0.1:6080 --vnc 127.0.0.1:5901
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/instagram-scraper-api.service >/dev/null <<'UNIT'
[Unit]
Description=Instagram persistent Chrome scraper API
After=network-online.target instagram-login-browser.service
Requires=instagram-login-browser.service

[Service]
Type=simple
User=instagram-scraper
Group=instagram-scraper
WorkingDirectory=/opt/husshone-instagram-scraper
EnvironmentFile=/etc/instagram-scraper.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/instagram-scraper-proxy.service >/dev/null <<'UNIT'
[Unit]
Description=Instagram scraper egress proxy forwarder (proxy-chain to residential/mobile upstream)
After=network-online.target

[Service]
Type=simple
User=instagram-scraper
Group=instagram-scraper
WorkingDirectory=/opt/husshone-instagram-scraper
EnvironmentFile=/etc/instagram-scraper.env
# Exits 0 when SCRAPER_PROXY_URL is unset (forwarder disabled) — Restart=on-failure leaves it inactive.
ExecStart=/usr/bin/node /opt/husshone-instagram-scraper/scripts/gcp-vm/proxy-forwarder.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/instagram-login-browser.service >/dev/null <<'UNIT'
[Unit]
Description=Manual Instagram login browser for persistent scraper profile
After=instagram-scraper-xvfb.service instagram-scraper-proxy.service
Requires=instagram-scraper-xvfb.service
Wants=instagram-scraper-proxy.service

[Service]
Type=simple
User=instagram-scraper
Group=instagram-scraper
EnvironmentFile=/etc/instagram-scraper.env
# Wrapper adds --proxy-server only when SCRAPER_PROXY_URL is set; otherwise launches direct (unchanged).
ExecStart=/opt/husshone-instagram-scraper/scripts/gcp-vm/start-login-browser.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
REMOTE

gcloud compute scp "$REMOTE_SCRIPT" "$VM_NAME:/tmp/husshone-instagram-scraper-remote-setup.sh" \
  --project "$PROJECT" \
  --zone "$ZONE" >/dev/null
rm -f "$REMOTE_SCRIPT"

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "bash /tmp/husshone-instagram-scraper-remote-setup.sh"

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "sudo tee /etc/instagram-scraper.env >/dev/null" <<EOF
PORT=8080
SCRAPER_API_KEY=$API_KEY
DISPLAY=:99
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_USER_DATA_DIR=/var/lib/instagram-scraper/chrome-profile
INSTAGRAM_LIVE_BROWSER=true
INSTAGRAM_BROWSER_URL=http://127.0.0.1:9222
INSTAGRAM_NOVNC_URL=http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080
INSTAGRAM_PROFILE_SCRAPER_HEADLESS=false
INSTAGRAM_PROFILE_SCRAPER_TIMEOUT_MS=120000
INSTAGRAM_MAX_URLS_PER_REQUEST=3
OUTPUT_DIR=/var/lib/instagram-scraper/outputs
SCRAPER_PROXY_URL=$SCRAPER_PROXY_URL
SCRAPER_PROXY_LISTEN_PORT=$SCRAPER_PROXY_LISTEN_PORT
EOF

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command \
  "sudo chown root:root /etc/instagram-scraper.env && sudo chmod 600 /etc/instagram-scraper.env && sudo systemctl enable --now instagram-scraper-xvfb instagram-scraper-x11vnc instagram-scraper-novnc instagram-scraper-proxy instagram-login-browser instagram-scraper-api && sudo systemctl restart instagram-scraper-proxy instagram-login-browser instagram-scraper-api"

EXTERNAL_IP="$(gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"

cat > outputs/vm-deployment.json <<EOF
{
  "project": "$PROJECT",
  "zone": "$ZONE",
  "vm": "$VM_NAME",
  "externalIp": "$EXTERNAL_IP",
  "apiUrl": "http://$EXTERNAL_IP:8080",
  "apiKeyFile": "$API_KEY_FILE",
  "loginTunnelCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE -- -N -L 6080:localhost:6080 -L 8080:localhost:8080",
  "loginIntentUrl": "http://127.0.0.1:8080/login-intent",
  "novncLocalUrl": "http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080"
}
EOF

echo "VM deployed."
echo "API: http://$EXTERNAL_IP:8080"
echo "API key file: $API_KEY_FILE"
echo "Login intent after tunnel: http://127.0.0.1:8080/login-intent"
echo "Deployment summary: outputs/vm-deployment.json"
