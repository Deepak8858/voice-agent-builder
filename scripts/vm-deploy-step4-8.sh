#!/bin/bash
set -e
cd /opt/voiceforge

# Source .env safely
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  value="${value%\"}"
  value="${value#\"}"
  export "$key=$value"
done < .env

# ---------------------------------------------------------------------------
# 4. Push images to ACR
# ---------------------------------------------------------------------------
ACR_NAME="voiceforgestaging"
ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io"
SUBSCRIPTION_ID="f932ef1c-5fbd-4914-9b9e-3c16ec3b300d"
RG="voiceforge-staging-rg"

MGMT_TOKEN=$(curl -s -H Metadata:true \
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

python3 -c "
import urllib.request, json
url = 'https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RG}/providers/Microsoft.ContainerRegistry/registries/${ACR_NAME}/listCredentials?api-version=2019-05-01'
req = urllib.request.Request(url, method='POST', headers={'Authorization': 'Bearer ${MGMT_TOKEN}', 'Content-Type': 'application/json'})
resp = urllib.request.urlopen(req)
data = json.loads(resp.read().decode())
with open('/tmp/acr_creds','w') as f:
    f.write(data['username'] + '\n')
    f.write(data['passwords'][0]['value'] + '\n')
"
ACR_USER=$(head -n1 /tmp/acr_creds)
ACR_PASS=$(tail -n1 /tmp/acr_creds)
rm -f /tmp/acr_creds

echo "${ACR_PASS}" | docker login "${ACR_LOGIN_SERVER}" -u "${ACR_USER}" --password-stdin

docker tag voiceforge-api:latest "${ACR_LOGIN_SERVER}/voiceforge-api:latest"
docker tag voiceforge-web:latest "${ACR_LOGIN_SERVER}/voiceforge-web:latest"
docker push "${ACR_LOGIN_SERVER}/voiceforge-api:latest"
docker push "${ACR_LOGIN_SERVER}/voiceforge-web:latest"

echo "Step4-PUSH-OK"

# ---------------------------------------------------------------------------
# 5. Run Prisma migrations
# ---------------------------------------------------------------------------
docker run --rm \
  -v "${PWD}/apps/api/prisma:/prisma" \
  -e DIRECT_URL="${DIRECT_URL}" \
  --entrypoint npx \
  node:20-slim \
  prisma migrate deploy --schema=/prisma/schema.prisma

echo "Step5-MIGRATE-OK"

# ---------------------------------------------------------------------------
# 6. Start Docker Compose stack
# ---------------------------------------------------------------------------
WEB_IMAGE=voiceforge-web API_IMAGE=voiceforge-api \
  docker compose -f docker-compose.prod.yml up -d --remove-orphans

echo "Step6-COMPOSE-OK"

# ---------------------------------------------------------------------------
# 7. Configure Nginx reverse proxy
# ---------------------------------------------------------------------------
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

# Optional certbot
apt-get install -y -qq certbot python3-certbot-nginx >/dev/null 2>&1 || true
certbot --nginx -d vocal.devdeepak.me --non-interactive --agree-tos -m "admin@vocal.devdeepak.me" --redirect 2>/dev/null || true
systemctl reload nginx

echo "Step7-NGINX-OK"

# ---------------------------------------------------------------------------
# 8. Health checks
# ---------------------------------------------------------------------------
sleep 10
API_OK=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:4000/health || echo "000")
WEB_OK=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/health || echo "000")

if [ "$API_OK" = "200" ] && [ "$WEB_OK" = "200" ]; then
  echo "Step8-HEALTH-OK"
  echo "✅ DEPLOYMENT SUCCESSFUL — API:${API_OK} Web:${WEB_OK}"
else
  echo "❌ HEALTH CHECK FAILED — API:${API_OK} Web:${WEB_OK}"
  exit 1
fi
