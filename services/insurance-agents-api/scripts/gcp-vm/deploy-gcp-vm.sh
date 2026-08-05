#!/usr/bin/env bash
# Deploy the Insurance Agents API to a VM in the fleet. Mirrors the brokercheck-api deploy
# (Node + Caddy TLS via sslip.io, no browser stack, no database).
#
# The upstream (Nationwide's own `search-api`) is KEYLESS, so there is exactly ONE secret:
#   insurance-agents-api-key   OUR bearer key — gates /v1/*. Auto-created (random) if absent.
set -euo pipefail

PROJECT="${PROJECT:-hushh-tech-prod}"
ZONE="${ZONE:-us-central1-c}"
REGION="${REGION:-${ZONE%-*}}"
VM_NAME="${VM_NAME:-insurance-agents-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"   # matches brokercheck: parallel paging is CPU-sensitive
STATIC_IP_NAME="${STATIC_IP_NAME:-insurance-agents-ip}"
NETWORK_TAG="${NETWORK_TAG:-insurance-agents}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"

SECRET_API_KEY="${SECRET_API_KEY:-insurance-agents-api-key}"

[[ -z "$PROJECT" ]] && { echo "PROJECT is required." >&2; exit 1; }
echo "Deploying $VM_NAME to $PROJECT/$ZONE"

# --- our bearer key: reuse the secret, or mint one so any Hushh project can read it -------
if ! API_KEY="$(gcloud secrets versions access latest --secret "$SECRET_API_KEY" --project "$PROJECT" 2>/dev/null)"; then
  echo "Creating $SECRET_API_KEY (random 32-byte hex)…"
  API_KEY="$(openssl rand -hex 32)"
  printf '%s' "$API_KEY" | gcloud secrets create "$SECRET_API_KEY" --data-file=- --replication-policy=automatic --project "$PROJECT"
fi

# --- static IP + firewall -----------------------------------------------------------------
gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || gcloud compute addresses create "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION"
STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION" --format='value(address)')"
HOSTNAME="insurance-agents.${STATIC_IP}.sslip.io"
echo "Static IP: $STATIC_IP  ->  https://$HOSTNAME"

gcloud compute firewall-rules describe "${NETWORK_TAG}-https" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute firewall-rules create "${NETWORK_TAG}-https" --project "$PROJECT" \
       --allow tcp:80,tcp:443 --target-tags "$NETWORK_TAG" --source-ranges 0.0.0.0/0 \
       --description "Public HTTPS for the Insurance Agents API"

# --- instance -----------------------------------------------------------------------------
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

# --- ship code ----------------------------------------------------------------------------
ARCHIVE="/tmp/husshone-insurance-agents.tgz"
tar --exclude='./node_modules' --exclude='./outputs' --exclude='./.git' -czf "$ARCHIVE" .
gcloud compute scp "$ARCHIVE" "$VM_NAME:/tmp/husshone-insurance-agents.tgz" --project "$PROJECT" --zone "$ZONE" >/dev/null

REMOTE="$(mktemp)"
cat > "$REMOTE" <<REMOTE_EOF
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https jq
if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy
fi
id insurance-agents >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /var/lib/insurance-agents --shell /usr/sbin/nologin insurance-agents
sudo mkdir -p /opt/husshone-insurance-agents
sudo rm -rf /opt/husshone-insurance-agents/*
sudo tar -xzf /tmp/husshone-insurance-agents.tgz -C /opt/husshone-insurance-agents
sudo chown -R insurance-agents:insurance-agents /opt/husshone-insurance-agents /var/lib/insurance-agents

sudo tee /etc/systemd/system/insurance-agents-api.service >/dev/null <<'UNIT'
[Unit]
Description=Insurance Agents API
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=insurance-agents
Group=insurance-agents
WorkingDirectory=/opt/husshone-insurance-agents
EnvironmentFile=/etc/insurance-agents.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/insurance-agents
[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${HOSTNAME} {
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
gcloud compute scp "$REMOTE" "$VM_NAME:/tmp/ins-remote-setup.sh" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$REMOTE"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "bash /tmp/ins-remote-setup.sh"

# --- env file (secrets injected here, moved into place) -----------------------------------
ENV_TMP="$(mktemp)"; umask 077
cat > "$ENV_TMP" <<EOF
PORT=8080
NODE_ENV=production
INSURANCE_AGENTS_API_KEY=$API_KEY
CACHE_SNAPSHOT_PATH=/var/lib/insurance-agents/cache-snapshot.json
CACHE_SNAPSHOT_INTERVAL_MS=300000
EOF
gcloud compute scp "$ENV_TMP" "$VM_NAME:/tmp/insurance-agents.env" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$ENV_TMP"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo mv /tmp/insurance-agents.env /etc/insurance-agents.env && sudo chown root:root /etc/insurance-agents.env && sudo chmod 600 /etc/insurance-agents.env"

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
  set -e
  sudo systemctl daemon-reload
  sudo systemctl enable --now insurance-agents-api.service
  sudo systemctl restart insurance-agents-api.service
  sudo systemctl enable --now caddy
  sudo systemctl reload caddy || sudo systemctl restart caddy
  sleep 3
  curl -fsS http://127.0.0.1:8080/health || echo 'LOCAL HEALTH FAILED'
"

mkdir -p outputs
cat > outputs/vm-deployment.json <<EOF
{ "project": "$PROJECT", "zone": "$ZONE", "vm": "$VM_NAME", "staticIp": "$STATIC_IP",
  "endpoint": "https://$HOSTNAME", "health": "https://$HOSTNAME/health",
  "example": "https://$HOSTNAME/v1/agents?lat=47.6769&lng=-122.2060&radiusMi=25&limit=10" }
EOF

echo
echo "Deployed. Endpoint: https://$HOSTNAME"
echo "  health : curl https://$HOSTNAME/health"
echo "  search : curl -N -H 'Authorization: Bearer <key>' 'https://$HOSTNAME/v1/agents?lat=47.6769&lng=-122.2060&radiusMi=25&limit=10'"
echo "  (First TLS handshake provisions the cert; allow ~30s.)"
