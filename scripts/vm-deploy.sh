#!/usr/bin/env bash
# =============================================================================
# VoiceForge AI — Complete Production Deployment Script (Azure VM)
# =============================================================================
# Run ON THE VM via: az vm run-command invoke ...
#
# What this does:
#   1. Fetches production .env from Azure Key Vault (VM MSI)
#   2. Pulls latest code from GitHub
#   3. Builds API + Web Docker images locally on the VM
#   4. Logs into ACR and pushes images
#   5. Runs Prisma migrations
#   6. Starts the stack with Docker Compose
#   7. Configures Nginx reverse proxy + SSL (Let's Encrypt)
#   8. Health checks
# =============================================================================
set -euo pipefail

APP_DIR="/opt/voiceforge"
ENV_FILE="${APP_DIR}/.env"
REPO_URL="https://github.com/Deepak8858/voice-agent-builder.git"
KV_NAME="voiceforgestagingkv"
ACR_NAME="voiceforgestaging"
ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io"
SUBSCRIPTION_ID="f932ef1c-5fbd-4914-9b9e-3c16ec3b300d"
DOMAIN="vocal.devdeepak.me"
RG="voiceforge-staging-rg"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { echo "===> [$(date +%H:%M:%S)] $*"; }

fetch_msi_token() {
  local resource="$1"
  curl -s -H Metadata:true \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${resource}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])"
}

# ---------------------------------------------------------------------------
# 1. Prepare /opt/voiceforge
# ---------------------------------------------------------------------------
log "[1/10] Preparing app directory..."
mkdir -p "$APP_DIR"
apt-get update -qq >/dev/null 2>&1 || true
apt-get install -y -qq git certbot python3-certbot-nginx >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 2. Fetch .env from Key Vault via VM Managed Identity
# ---------------------------------------------------------------------------
log "[2/10] Fetching .env from Key Vault (${KV_NAME})..."
TOKEN=$(fetch_msi_token "https://vault.azure.net")
python3 -c "
import urllib.request, json, sys
url = 'https://${KV_NAME}.vault.azure.net/secrets/voiceforge-env-file/?api-version=7.4'
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ${TOKEN}'})
resp = urllib.request.urlopen(req)
data = json.loads(resp.read().decode())
with open('${ENV_FILE}', 'w') as f:
    f.write(data['value'])
"
chmod 600 "$ENV_FILE"
export $(grep -v '^#' "$ENV_FILE" | xargs) || true
log "Done."

# ---------------------------------------------------------------------------
# 3. Pull latest source code
# ---------------------------------------------------------------------------
log "[3/10] Pulling latest code..."
cd "$APP_DIR"
if [ ! -d ".git" ]; then
  git clone "$REPO_URL" . || true
fi
git reset --hard HEAD
git pull origin main
log "Done."

# ---------------------------------------------------------------------------
# 4. Build API image locally
# ---------------------------------------------------------------------------
log "[4/10] Building API image..."
cd "$APP_DIR"
docker build -f Dockerfile.api -t voiceforge-api:latest .
log "Done."

# ---------------------------------------------------------------------------
# 5. Build Web image locally (with production build-args)
# ---------------------------------------------------------------------------
log "[5/10] Building Web image..."
cd "$APP_DIR"
# Extract needed public vars from .env (safe to show in build args)
PK=$(grep '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')
API_URL=$(grep '^NEXT_PUBLIC_API_URL=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')
APP_URL=$(grep '^NEXT_PUBLIC_APP_URL=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')
SI=$(grep '^NEXT_PUBLIC_CLERK_SIGN_IN_URL=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')
SU=$(grep '^NEXT_PUBLIC_CLERK_SIGN_UP_URL=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')
ASI=$(grep '^NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')
ASU=$(grep '^NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')

docker build -f Dockerfile.web \
  --build-arg NEXT_PUBLIC_API_URL="${API_URL}" \
  --build-arg NEXT_PUBLIC_APP_URL="${APP_URL}" \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${PK}" \
  --build-arg NEXT_PUBLIC_CLERK_SIGN_IN_URL="${SI}" \
  --build-arg NEXT_PUBLIC_CLERK_SIGN_UP_URL="${SU}" \
  --build-arg NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL="${ASI}" \
  --build-arg NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL="${ASU}" \
  -t voiceforge-web:latest .
log "Done."

# ---------------------------------------------------------------------------
# 6. Login to ACR and push images
# ---------------------------------------------------------------------------
log "[6/10] Logging into ACR and pushing images..."
MGMT_TOKEN=$(fetch_msi_token "https://management.azure.com")
python3 -c "
import urllib.request, json, sys
url = 'https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RG}/providers/Microsoft.ContainerRegistry/registries/${ACR_NAME}/listCredentials?api-version=2019-05-01'
req = urllib.request.Request(url, method='POST', headers={'Authorization': 'Bearer ${MGMT_TOKEN}', 'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req)
data = json.loads(resp.read().decode())
with open('/tmp/acr_creds', 'w') as f:
    f.write(data['username'] + '\n')
    f.write(data['passwords'][0]['value'] + '\n')
"
ACR_USER=$(head -n1 /tmp/acr_creds)
ACR_PASS=$(tail -n1 /tmp/acr_creds)
rm -f /tmp/acr_creds

echo "$ACR_PASS" | docker login "$ACR_LOGIN_SERVER" -u "$ACR_USER" --password-stdin

docker tag voiceforge-api:latest "${ACR_LOGIN_SERVER}/voiceforge-api:latest"
docker tag voiceforge-web:latest "${ACR_LOGIN_SERVER}/voiceforge-web:latest"
docker push "${ACR_LOGIN_SERVER}/voiceforge-api:latest"
docker push "${ACR_LOGIN_SERVER}/voiceforge-web:latest"
log "Done."

# ---------------------------------------------------------------------------
# 7. Run Prisma migrations
# ---------------------------------------------------------------------------
log "[7/10] Running Prisma migrations..."
DIRECT_URL=$(grep '^DIRECT_URL=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')
docker run --rm \
  --env-file "$ENV_FILE" \
  -e DATABASE_URL="${DIRECT_URL}" \
  -v "${APP_DIR}/apps/api/prisma:/prisma" \
  --entrypoint sh \
  node:20-slim \
  -c 'apt-get update -qq && apt-get install -y -qq openssl > /dev/null 2>&1 && npx prisma@5.22.0 migrate deploy --schema=/prisma/schema.prisma'
log "Done."

# ---------------------------------------------------------------------------
# 8. Start Docker Compose stack
# ---------------------------------------------------------------------------
log "[8/10] Starting Docker Compose stack..."
cd "$APP_DIR"
WEB_IMAGE=voiceforge-web API_IMAGE=voiceforge-api \
  docker compose -f docker-compose.prod.yml up -d --remove-orphans
log "Done."

# ---------------------------------------------------------------------------
# 9. Configure Nginx reverse proxy
# ---------------------------------------------------------------------------
log "[9/10] Configuring Nginx..."
NGINX_CONF="/etc/nginx/sites-available/voiceforge"
NGINX_ENABLED="/etc/nginx/sites-enabled/voiceforge"

cat > "$NGINX_CONF" <<'EOF'
upstream web_local {
    server 127.0.0.1:3000;
    keepalive 32;
}
upstream api_local {
    server 127.0.0.1:4000;
    keepalive 32;
}
server {
    listen 80;
    server_name vocal.devdeepak.me;
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}
server {
    listen 443 ssl http2;
    server_name vocal.devdeepak.me;
    location /api/v1/ {
        proxy_pass http://api_local/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }
    location /api/health {
        proxy_pass http://api_local/health;
        access_log off;
    }
    location / {
        proxy_pass http://web_local;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }
    location /_next/static/ {
        proxy_pass http://web_local;
        proxy_cache_valid 200 365d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sf "$NGINX_CONF" "$NGINX_ENABLED"
nginx -t && systemctl reload nginx

# Optional: certbot SSL (non-interactive)
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect || true
systemctl reload nginx
log "Done."

# ---------------------------------------------------------------------------
# 10. Health checks
# ---------------------------------------------------------------------------
log "[10/10] Running health checks..."
sleep 8
API_OK=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:4000/health || echo "000")
WEB_OK=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/health || echo "000")

if [ "$API_OK" = "200" ] && [ "$WEB_OK" = "200" ]; then
  log "✅ DEPLOYMENT SUCCESSFUL — API:${API_OK} Web:${WEB_OK}"
else
  log "❌ HEALTH CHECK FAILED — API:${API_OK} Web:${WEB_OK}"
  exit 1
fi
