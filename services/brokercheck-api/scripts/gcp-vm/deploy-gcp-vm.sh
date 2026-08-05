#!/usr/bin/env bash
# Deploy the BrokerCheck Advisor API to a VM in the scraper fleet.
#
# This is the SIMPLEST VM in the fleet. Unlike the social scrapers it needs NO browser
# stack — no chromium, xvfb, x11vnc, noVNC, or login units — because BrokerCheck's API is
# public and unauthenticated. And unlike the directory crawlers it needs no Cloud SQL,
# no work queue, and no 24/7 worker: it answers requests, it does not crawl.
#
# What it does install:
#   - the Node service on 127.0.0.1:8080
#   - Caddy terminating TLS on :443 with an automatic Let's Encrypt cert for an
#     sslip.io hostname (which resolves to the VM's own static IP), same as linkedin-scraper
#
# The endpoint is PUBLIC and unauthenticated by design — consumers should not need a
# secret to read public regulatory data. Abuse is bounded by the service's per-IP rate
# limiter. Set BROKERCHECK_API_KEY below if you ever need to lock it down.
set -euo pipefail

PROJECT="${PROJECT:-hushh-tech-prod}"
ZONE="${ZONE:-us-central1-c}"
REGION="${REGION:-${ZONE%-*}}"
VM_NAME="${VM_NAME:-brokercheck-api-vm}"
# e2-medium, not e2-small: full-radius coverage fires ~20 concurrent HTTPS fetches per
# cold query, and e2-small's 0.5 vCPU baseline throttled that to 18s once burst credits
# ran out (the same query took 4.6s off-VM). Matches the rest of the fleet.
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
STATIC_IP_NAME="${STATIC_IP_NAME:-brokercheck-api-ip}"
NETWORK_TAG="${NETWORK_TAG:-brokercheck-api}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"

# Caller key. Fetched from Secret Manager so it never lands in shell history or a repo.
# Rotate with:  printf '%s' "$(openssl rand -hex 32)" |
#   gcloud secrets versions add brokercheck-api-key --data-file=- --project hushh-tech-prod
# then re-run this script.
#
# Set SECRET_API_KEY='' to deploy a fully open endpoint instead.
SECRET_API_KEY="${SECRET_API_KEY-brokercheck-api-key}"
BROKERCHECK_API_KEY="${BROKERCHECK_API_KEY:-}"
if [[ -z "$BROKERCHECK_API_KEY" && -n "$SECRET_API_KEY" ]]; then
  if ! BROKERCHECK_API_KEY="$(gcloud secrets versions access latest --secret "$SECRET_API_KEY" --project "$PROJECT" 2>/dev/null)"; then
    echo "Missing Secret Manager secret '$SECRET_API_KEY' in $PROJECT." >&2
    echo "Create it, or pass SECRET_API_KEY='' to deploy an open endpoint." >&2
    exit 1
  fi
fi

if [[ -z "${PROJECT}" ]]; then
  echo "PROJECT is required." >&2
  exit 1
fi

echo "Deploying $VM_NAME to $PROJECT/$ZONE"

# --- static IP: the hostname is derived from it, so it must not drift ---------
if ! gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION"
fi
STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" --project "$PROJECT" --region "$REGION" --format='value(address)')"
HOSTNAME="brokercheck.${STATIC_IP}.sslip.io"
echo "Static IP: $STATIC_IP  ->  https://$HOSTNAME"

# --- firewall: 80 (ACME HTTP-01 challenge) + 443 -----------------------------
if ! gcloud compute firewall-rules describe "${NETWORK_TAG}-https" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "${NETWORK_TAG}-https" \
    --project "$PROJECT" --allow tcp:80,tcp:443 \
    --target-tags "$NETWORK_TAG" --source-ranges 0.0.0.0/0 \
    --description "Public HTTPS for the BrokerCheck Advisor API"
fi

# --- instance ----------------------------------------------------------------
if ! gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
  CREATE_ARGS=(
    --project "$PROJECT" --zone "$ZONE" --machine-type "$MACHINE_TYPE"
    --image-family debian-12 --image-project debian-cloud
    --boot-disk-size 20GB --address "$STATIC_IP"
    --tags "$NETWORK_TAG"
    --scopes "https://www.googleapis.com/auth/cloud-platform"
  )
  if [[ -n "$SERVICE_ACCOUNT" ]]; then CREATE_ARGS+=(--service-account "$SERVICE_ACCOUNT"); fi
  gcloud compute instances create "$VM_NAME" "${CREATE_ARGS[@]}"
else
  # Ensure the tag exists on a pre-existing VM, else the firewall rule does nothing.
  gcloud compute instances add-tags "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --tags "$NETWORK_TAG" >/dev/null 2>&1 || true
fi

echo "Waiting for SSH..."
for i in $(seq 1 30); do
  if gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "true" >/dev/null 2>&1; then break; fi
  if [[ $i -eq 30 ]]; then echo "SSH did not become ready after ~5min" >&2; exit 1; fi
  sleep 10
done

# --- ship the code -----------------------------------------------------------
ARCHIVE="/tmp/husshone-brokercheck-api.tgz"
tar --exclude='./node_modules' --exclude='./outputs' --exclude='./.git' -czf "$ARCHIVE" .
gcloud compute scp "$ARCHIVE" "$VM_NAME:/tmp/husshone-brokercheck-api.tgz" --project "$PROJECT" --zone "$ZONE" >/dev/null

REMOTE="$(mktemp)"
cat > "$REMOTE" <<REMOTE_EOF
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https jq

# Node 22 (Debian 12 ships Node 18; AbortSignal.timeout + global fetch need >=18, but we
# pin forward so behaviour matches local dev).
if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

# Caddy: TLS termination + automatic Let's Encrypt for the sslip.io hostname.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi

id brokercheck >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /var/lib/brokercheck --shell /usr/sbin/nologin brokercheck

sudo mkdir -p /opt/husshone-brokercheck-api
sudo rm -rf /opt/husshone-brokercheck-api/*
sudo tar -xzf /tmp/husshone-brokercheck-api.tgz -C /opt/husshone-brokercheck-api
sudo chown -R brokercheck:brokercheck /opt/husshone-brokercheck-api /var/lib/brokercheck

# No runtime dependencies at all — the service is stdlib-only. npm ci would fail without
# a lockfile, and there is nothing to install, so this is deliberately skipped.

sudo tee /etc/systemd/system/brokercheck-api.service >/dev/null <<'UNIT'
[Unit]
Description=BrokerCheck Advisor API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=brokercheck
Group=brokercheck
WorkingDirectory=/opt/husshone-brokercheck-api
EnvironmentFile=/etc/brokercheck-api.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
# ProtectSystem=strict makes the WHOLE filesystem read-only, which would silently break the
# cache snapshot (and leave the service warming from scratch on every restart). This is the
# one path the service must be able to write.
ReadWritePaths=/var/lib/brokercheck

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${HOSTNAME} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		# Streaming endpoint: never buffer, and allow long-lived responses.
		flush_interval -1
		transport http {
			response_header_timeout 5m
		}
	}
}
CADDY
REMOTE_EOF

gcloud compute scp "$REMOTE" "$VM_NAME:/tmp/brokercheck-remote-setup.sh" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$REMOTE"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "bash /tmp/brokercheck-remote-setup.sh"

# --- env file (built locally, moved into place to dodge shell quoting) --------
ENV_TMP="$(mktemp)"
umask 077
cat > "$ENV_TMP" <<EOF
PORT=8080
BROKERCHECK_API_KEY=$BROKERCHECK_API_KEY
NODE_ENV=production
CACHE_SNAPSHOT_PATH=/var/lib/brokercheck/cache-snapshot.json
CACHE_SNAPSHOT_INTERVAL_MS=300000
EOF
gcloud compute scp "$ENV_TMP" "$VM_NAME:/tmp/brokercheck-api.env" --project "$PROJECT" --zone "$ZONE" >/dev/null
rm -f "$ENV_TMP"
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
  --command "sudo mv /tmp/brokercheck-api.env /etc/brokercheck-api.env && sudo chown root:root /etc/brokercheck-api.env && sudo chmod 600 /etc/brokercheck-api.env"

gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "
  set -e
  sudo systemctl daemon-reload
  sudo systemctl enable --now brokercheck-api.service
  sudo systemctl restart brokercheck-api.service
  sudo systemctl enable --now caddy
  sudo systemctl reload caddy || sudo systemctl restart caddy
  sleep 3
  echo '--- local health ---'
  curl -fsS http://127.0.0.1:8080/health || echo 'LOCAL HEALTH FAILED'
"

mkdir -p outputs
cat > outputs/vm-deployment.json <<EOF
{
  "project": "$PROJECT",
  "zone": "$ZONE",
  "vm": "$VM_NAME",
  "staticIp": "$STATIC_IP",
  "endpoint": "https://$HOSTNAME",
  "health": "https://$HOSTNAME/health",
  "example": "https://$HOSTNAME/v1/advisors?lat=47.6769&lng=-122.2060&radiusMi=10&limit=10",
  "logsCommand": "gcloud compute ssh $VM_NAME --project $PROJECT --zone $ZONE --command 'sudo journalctl -u brokercheck-api -f'"
}
EOF

echo
echo "Deployed. Endpoint: https://$HOSTNAME"
echo "  health : curl https://$HOSTNAME/health"
echo "  search : curl -N 'https://$HOSTNAME/v1/advisors?lat=47.6769&lng=-122.2060&radiusMi=10&limit=10'"
echo "  logs   : gcloud compute ssh $VM_NAME --zone $ZONE --command 'sudo journalctl -u brokercheck-api -f'"
echo "  (Caddy's first TLS handshake provisions the cert and can take ~30s.)"
echo "Summary: outputs/vm-deployment.json"
