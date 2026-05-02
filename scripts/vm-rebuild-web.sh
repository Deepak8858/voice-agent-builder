#!/usr/bin/env bash
set -e
cd /opt/voiceforge

# Read build args from .env
PK=$(grep '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' .env | cut -d'=' -f2- | tr -d '"')
API_URL=$(grep '^NEXT_PUBLIC_API_URL=' .env | cut -d'=' -f2- | tr -d '"')
APP_URL=$(grep '^NEXT_PUBLIC_APP_URL=' .env | cut -d'=' -f2- | tr -d '"')
SI=$(grep '^NEXT_PUBLIC_CLERK_SIGN_IN_URL=' .env | cut -d'=' -f2- | tr -d '"')
SU=$(grep '^NEXT_PUBLIC_CLERK_SIGN_UP_URL=' .env | cut -d'=' -f2- | tr -d '"')
ASI=$(grep '^NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=' .env | cut -d'=' -f2- | tr -d '"')
ASU=$(grep '^NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=' .env | cut -d'=' -f2- | tr -d '"')

echo "Building web image..."
docker build -f Dockerfile.web \
  --build-arg NEXT_PUBLIC_API_URL="${API_URL}" \
  --build-arg NEXT_PUBLIC_APP_URL="${APP_URL}" \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${PK}" \
  --build-arg NEXT_PUBLIC_CLERK_SIGN_IN_URL="${SI}" \
  --build-arg NEXT_PUBLIC_CLERK_SIGN_UP_URL="${SU}" \
  --build-arg NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL="${ASI}" \
  --build-arg NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL="${ASU}" \
  -t voiceforge-web:latest .

echo "Starting stack..."
docker compose -f docker-compose.prod.yml up -d

echo "Health checks..."
sleep 5
API_OK=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:4000/api/v1/health || echo "000")
WEB_OK=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/health || echo "000")
echo "API: ${API_OK}  Web: ${WEB_OK}"
