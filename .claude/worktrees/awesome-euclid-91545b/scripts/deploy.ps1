# =============================================================================
# VoiceForge AI — Direct Deploy Script (PowerShell)
# =============================================================================
# Rebuilds and deploys all Docker containers to EC2
# Usage: .\deploy.ps1 [-Target] [api|web|all]
# =============================================================================

param(
    [ValidateSet("api", "web", "all")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Stop"

$EC2_HOST = "13.234.56.188"
$EC2_USER = "ubuntu"
$SSH_KEY = "$HOME\.ssh\voiceforge_ec2.pem"
$REGION = "ap-south-1"
$ECR_REGISTRY = "393060838606.dkr.ecr.$REGION.amazonaws.com"

Write-Host "🚀 VoiceForge Direct Deploy" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "Host: $EC2_HOST"
Write-Host "Target: $Target"
Write-Host "ECR: $ECR_REGISTRY"
Write-Host ""

function Invoke-SSHCommand {
    param([string]$Commands)
    ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i $SSH_KEY "$EC2_USER@$EC2_HOST" $Commands
}

# ECR Login
Write-Host "🔐 Logging in to ECR..." -ForegroundColor Yellow
Invoke-SSHCommand @"
set -euo pipefail
export PATH=`$HOME/.local/bin:`$PATH
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR_REGISTRY
echo "✅ ECR login OK"
"@

# Build API
if ($Target -eq "all" -or $Target -eq "api") {
    Write-Host "" -ForegroundColor Cyan
    Write-Host "━━━ Building API ━━━" -ForegroundColor Cyan
    Invoke-SSHCommand @"
set -euo pipefail
cd /opt/voiceforge
echo "🔨 Building API..."
docker build -t voiceforge-api:latest -f Dockerfile.api .
docker tag voiceforge-api:latest $ECR_REGISTRY/voiceforge-api:latest
docker push $ECR_REGISTRY/voiceforge-api:latest
echo "✅ API built and pushed"
"@
}

# Build Web
if ($Target -eq "all" -or $Target -eq "web") {
    Write-Host "" -ForegroundColor Cyan
    Write-Host "━━━ Building Web ━━━" -ForegroundColor Cyan
    Invoke-SSHCommand @"
set -euo pipefail
cd /opt/voiceforge
echo "🔨 Building Web..."
docker build -t voiceforge-web:latest -f Dockerfile.web .
docker tag voiceforge-web:latest $ECR_REGISTRY/voiceforge-web:latest
docker push $ECR_REGISTRY/voiceforge-web:latest
echo "✅ Web built and pushed"
"@
}

# Deploy
Write-Host "" -ForegroundColor Cyan
Write-Host "━━━ Deploying to EC2 ━━━" -ForegroundColor Cyan
Invoke-SSHCommand @"
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
docker ps --format "table {{.Names}}	{{.Status}}"
"@

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "✅ Deployment complete!" -ForegroundColor Green