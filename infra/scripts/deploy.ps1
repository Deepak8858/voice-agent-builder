# =============================================================================
# VoiceForge AI — Manual Azure Deployment Script (PowerShell)
# =============================================================================
# Usage:
#   .\infra\scripts\deploy.ps1 -Environment staging -ResourceGroup voiceforge-staging-rg -Location eastus
# Prerequisites:
#   - Azure PowerShell (Az module) installed and logged in
#   - Docker images already built and pushed to ACR
# =============================================================================

param(
    [string]$Environment = "staging",
    [string]$ResourceGroup = "voiceforge-${Environment}-rg",
    [string]$Location = "eastus",
    [string]$ImageTag = "latest"
)

$ErrorActionPreference = "Stop"

$acrName = "vf" + ((Get-AzResourceGroup -Name $ResourceGroup -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ResourceId) ?? (New-AzResourceGroup -Name $ResourceGroup -Location $Location).ResourceId | ForEach-Object { ($_ | Get-FileHash -Algorithm MD5).Hash.Substring(0,8).ToLower() }) + "acr"

Write-Host "🚀 Deploying VoiceForge AI to Azure" -ForegroundColor Cyan
Write-Host "   Environment: $Environment"
Write-Host "   Resource Group: $ResourceGroup"
Write-Host "   Location: $Location"
Write-Host ""

# Ensure resource group exists
$rg = Get-AzResourceGroup -Name $ResourceGroup -ErrorAction SilentlyContinue
if (-not $rg) {
    $rg = New-AzResourceGroup -Name $ResourceGroup -Location $Location
}

Write-Host "🔨 Deploying Bicep infrastructure..." -ForegroundColor Cyan
$deployment = New-AzResourceGroupDeployment `
    -ResourceGroupName $ResourceGroup `
    -TemplateFile "infra/bicep/main.bicep" `
    -environment $Environment `
    -acrAdminUserEnabled $true `
    -apiImage "$($acrName).azurecr.io/voiceforge-api:${ImageTag}" `
    -webImage "$($acrName).azurecr.io/voiceforge-web:${ImageTag}" `
    -databaseUrl $env:DATABASE_URL `
    -directUrl $env:DIRECT_URL `
    -redisUrl $env:REDIS_URL `
    -jwtSecret $env:JWT_SECRET `
    -encryptionKey $env:ENCRYPTION_KEY `
    -clerkSecretKey $env:CLERK_SECRET_KEY `
    -clerkPublishableKey $env:CLERK_PUBLISHABLE_KEY `
    -openaiApiKey $env:OPENAI_API_KEY `
    -vapiApiKey $env:VAPI_API_KEY

Write-Host ""
Write-Host "✅ Deployment complete!" -ForegroundColor Green
Write-Host "Outputs:"
$deployment.Outputs | Format-List
