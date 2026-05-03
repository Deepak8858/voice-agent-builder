# =============================================================================
# VoiceForge AI — EC2 Deployment (GitHub Actions SSH Script)
# =============================================================================
# This script runs on the EC2 instance during GitHub Actions deployment.
# Copied to /opt/voiceforge/deploy.sh and executed via appleboy/ssh-action.
# =============================================================================

set -euo pipefail

export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION="ap-south-1"
export ECR_REGISTRY=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
export IMAGE_TAG="${IMAGE_TAG:-latest}"
export COMPOSE_PROJECT_NAME="voiceforge"
export COMPOSE_FILE="/opt/voiceforge/docker-compose.prod.yml"

echo "🔐 Logging in to ECR..."
aws ecr get-login-password --region ${AWS_REGION} | \
  docker login --username AWS --password-stdin ${ECR_REGISTRY}

echo "📥 Pulling images..."
docker compose -f ${COMPOSE_FILE} pull

echo "🚀 Restarting services..."
docker compose -f ${COMPOSE_FILE} up -d --remove-orphans

echo "🧹 Pruning old images..."
docker image prune -af --filter "until=168h"

echo "🩺 Health checks..."
sleep 15

# API health check
curl -sf --max-time 10 http://localhost:4000/api/v1/health || {
  echo "❌ API health check failed"
  docker compose -f ${COMPOSE_FILE} logs api
  exit 1
}

# Web health check
curl -sf --max-time 10 -o /dev/null -w "%{http_code}" http://localhost:3000/api/health | \
  grep -q "200" || {
  echo "❌ Web health check failed"
  docker compose -f ${COMPOSE_FILE} logs web
  exit 1
}

echo ""
echo "✅ Deployment successful!"
echo "   - API: http://localhost:4000/api/v1/health"
echo "   - Web: http://localhost:3000/api/health"