#!/bin/bash
# =============================================================================
# VoiceForge AI — Direct Deploy Script
# =============================================================================
# Rebuilds and deploys all Docker containers to EC2
# Usage: ./deploy.sh [api|web|all]
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EC2_HOST="${EC2_HOST:-13.234.56.188}"
EC2_USER="${EC2_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/voiceforge_ec2.pem}"
REGION="${AWS_REGION:-ap-south-1}"
ECR_REGISTRY="${AWS_ACCOUNT_ID:-393060838606}.dkr.ecr.${REGION}.amazonaws.com"
TARGET="${1:-all}"

echo "🚀 VoiceForge Direct Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Host: $EC2_HOST"
echo "Target: $TARGET"
echo "ECR: $ECR_REGISTRY"
echo ""

# SSH command helper
SSH_CMD="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i $SSH_KEY $EC2_USER@$EC2_HOST"

# Deploy function
deploy_to_ec2() {
    local SERVICE=$1
    local DOCKERFILE=$2
    local IMAGE_NAME=$3

    echo "📦 Building $SERVICE image..."
    $SSH_CMD << SSHEND
        set -euo pipefail
        cd /opt/voiceforge

        echo "🔨 Building $SERVICE..."
        docker build -t voiceforge-$SERVICE:latest -f $DOCKERFILE .

        echo "🏷️ Tagging for ECR..."
        docker tag voiceforge-$SERVICE:latest $ECR_REGISTRY/voiceforge-$SERVICE:latest

        echo "📤 Pushing to ECR..."
        export PATH=\$HOME/.local/bin:\$PATH
        aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
        docker push $ECR_REGISTRY/voiceforge-$SERVICE:latest

        echo "✅ $SERVICE built and pushed"
SSHEND
}

# Deploy to EC2
deploy_services() {
    echo "🔐 Logging in to ECR..."
    $SSH_CMD << 'SSHEND'
        set -euo pipefail
        export PATH=$HOME/.local/bin:$PATH
        aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 393060838606.dkr.ecr.ap-south-1.amazonaws.com
        echo "✅ ECR login OK"
SSHEND

    if [ "$TARGET" = "all" ] || [ "$TARGET" = "api" ]; then
        echo ""
        echo "━━━ Building API ━━━"
        $SSH_CMD << 'SSHEND'
            set -euo pipefail
            cd /opt/voiceforge
            docker build -t voiceforge-api:latest -f Dockerfile.api .
            docker tag voiceforge-api:latest 393060838606.dkr.ecr.ap-south-1.amazonaws.com/voiceforge-api:latest
            docker push 393060838606.dkr.ecr.ap-south-1.amazonaws.com/voiceforge-api:latest
            echo "✅ API built and pushed"
SSHEND
    fi

    if [ "$TARGET" = "all" ] || [ "$TARGET" = "web" ]; then
        echo ""
        echo "━━━ Building Web ━━━"
        $SSH_CMD << 'SSHEND'
            set -euo pipefail
            cd /opt/voiceforge
            docker build -t voiceforge-web:latest -f Dockerfile.web .
            docker tag voiceforge-web:latest 393060838606.dkr.ecr.ap-south-1.amazonaws.com/voiceforge-web:latest
            docker push 393060838606.dkr.ecr.ap-south-1.amazonaws.com/voiceforge-web:latest
            echo "✅ Web built and pushed"
SSHEND
    fi

    echo ""
    echo "━━━ Deploying to EC2 ━━━"
    $SSH_CMD << 'SSHEND'
        set -euo pipefail
        cd /opt/voiceforge

        echo "📥 Pulling images..."
        docker compose -f docker-compose.prod.yml pull

        echo "🚀 Restarting services..."
        docker compose -f docker-compose.prod.yml up -d --remove-orphans

        echo "🧹 Pruning old images..."
        docker image prune -af --filter "until=168h"

        echo "⏳ Waiting for services..."
        sleep 20

        echo "🩺 Health checks..."
        curl -sf http://localhost:4000/api/v1/health && echo " ✅ API OK" || echo " ❌ API FAIL"
        curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/api/health && echo " ✅ Web OK" || echo " ❌ Web FAIL"

        echo ""
        echo "📋 Container status:"
        docker ps --format "table {{.Names}}\t{{.Status}}"
SSHEND

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ Deployment complete!"
}

# Main execution
deploy_services