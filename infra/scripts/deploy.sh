#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# VoiceForge AI — Manual Azure Deployment Script
# =============================================================================
# Usage:
#   ./infra/scripts/deploy.sh <environment> <resource-group> <location>
# Example:
#   ./infra/scripts/deploy.sh staging voiceforge-staging-rg eastus
# Prerequisites:
#   - Azure CLI (az) installed and logged in
#   - Docker images already built and pushed to ACR
# =============================================================================

ENVIRONMENT=${1:-staging}
RESOURCE_GROUP=${2:-voiceforge-${ENVIRONMENT}-rg}
LOCATION=${3:-eastus}

ACR_NAME="vf$(az group show --name "$RESOURCE_GROUP" --query id -o tsv | md5sum | cut -c1-8)acr"
IMAGE_TAG=${IMAGE_TAG:-latest}

echo "🚀 Deploying VoiceForge AI to Azure"
echo "   Environment: $ENVIRONMENT"
echo "   Resource Group: $RESOURCE_GROUP"
echo "   Location: $LOCATION"
echo ""

# Create resource group if it doesn't exist
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "🔨 Deploying Bicep infrastructure..."
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file infra/bicep/main.bicep \
  --parameters environment="$ENVIRONMENT" \
  --parameters acrAdminUserEnabled=true \
  --parameters apiImage="${ACR_NAME}.azurecr.io/voiceforge-api:${IMAGE_TAG}" \
  --parameters webImage="${ACR_NAME}.azurecr.io/voiceforge-web:${IMAGE_TAG}" \
  --parameters "databaseUrl=$DATABASE_URL" \
  --parameters "directUrl=$DIRECT_URL" \
  --parameters "redisUrl=$REDIS_URL" \
  --parameters "jwtSecret=$JWT_SECRET" \
  --parameters "encryptionKey=$ENCRYPTION_KEY" \
  --parameters "clerkSecretKey=$CLERK_SECRET_KEY" \
  --parameters "clerkPublishableKey=$CLERK_PUBLISHABLE_KEY" \
  --parameters "openaiApiKey=$OPENAI_API_KEY" \
  --parameters "vapiApiKey=$VAPI_API_KEY"

echo ""
echo "✅ Deployment complete!"
echo "   Run 'az deployment group show -g $RESOURCE_GROUP -n <deployment-name> --query properties.outputs' to see endpoints."
