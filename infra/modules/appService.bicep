// =============================================================================
// Module: App Service Plan + Web Apps (Web & API)
// =============================================================================

@description('Azure region')
param location string

@description('Suffix for resource names')
param namingSuffix string

@description('ACR login server')
param acrLoginServer string

@description('PostgreSQL host FQDN')
param postgresHost string

@description('PostgreSQL database name')
param postgresDatabase string

@description('PostgreSQL username')
param postgresUser string

@description('PostgreSQL password')
@secure()
param postgresPassword string

@description('Redis hostname')
param redisHost string

@description('Redis primary key')
@secure()
param redisKey string

@description('Container image tag')
param imageTag string = 'latest'

@description('Resource tags')
param tags object = {}

@description('App Service Plan SKU')
@allowed(['B1', 'B2', 'B3', 'S1', 'S2', 'S3', 'P1v2', 'P2v2', 'P3v2'])
param planSku string = 'B2'

@description('Log Analytics workspace ID (optional)')
param logAnalyticsWorkspaceId string = ''

// =============================================================================
// Log Analytics & App Insights (optional)
// =============================================================================

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (empty(logAnalyticsWorkspaceId)) {
  name: 'law-${namingSuffix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'ai-${namingSuffix}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: empty(logAnalyticsWorkspaceId) ? logAnalytics.id : logAnalyticsWorkspaceId
  }
}

// =============================================================================
// App Service Plan
// =============================================================================

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${namingSuffix}'
  location: location
  tags: tags
  kind: 'linux'
  properties: {
    reserved: true
    perSiteScaling: false
  }
  sku: {
    name: planSku
    tier: planSku == 'B1' || planSku == 'B2' || planSku == 'B3' ? 'Basic' : planSku == 'S1' || planSku == 'S2' || planSku == 'S3' ? 'Standard' : 'PremiumV2'
  }
}

// =============================================================================
// Common derived settings
// =============================================================================

var dbUrl = 'postgresql://${postgresUser}:${postgresPassword}@${postgresHost}:5432/${postgresDatabase}?pgbouncer=true&sslmode=require'
var directUrl = 'postgresql://${postgresUser}:${postgresPassword}@${postgresHost}:5432/${postgresDatabase}?sslmode=require'
var redisUrl = 'rediss://:${redisKey}@${redisHost}:6380'

var apiImage = '${acrLoginServer}/voiceforge-api:${imageTag}'
var webImage = '${acrLoginServer}/voiceforge-web:${imageTag}'

// =============================================================================
// API Web App
// =============================================================================

resource apiApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'api-${namingSuffix}'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'DOCKER|${apiImage}'
      healthCheckPath: '/health'
      alwaysOn: true
      httpLoggingEnabled: true
      detailedErrorLoggingEnabled: true
      appSettings: [
        { name: 'DOCKER_REGISTRY_SERVER_URL', value: 'https://${acrLoginServer}' }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsights.properties.InstrumentationKey }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'WEBSITES_PORT', value: '4000' }
        { name: 'API_PORT', value: '4000' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'DATABASE_URL', value: dbUrl }
        { name: 'DIRECT_URL', value: directUrl }
        { name: 'REDIS_URL', value: redisUrl }
        // Provider defaults; override via CI/CD or Portal for real keys
        { name: 'AUTH_PROVIDER', value: 'mock' }
        { name: 'VOICE_PROVIDER', value: 'mock' }
        { name: 'LLM_PROVIDER', value: 'mock' }
        { name: 'EMBEDDING_PROVIDER', value: 'mock' }
      ]
    }
    httpsOnly: true
  }
}

// =============================================================================
// Web Frontend App
// =============================================================================

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'web-${namingSuffix}'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'DOCKER|${webImage}'
      healthCheckPath: '/api/health'
      alwaysOn: true
      httpLoggingEnabled: true
      detailedErrorLoggingEnabled: true
      appSettings: [
        { name: 'DOCKER_REGISTRY_SERVER_URL', value: 'https://${acrLoginServer}' }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsights.properties.InstrumentationKey }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'PORT', value: '3000' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'NEXT_PUBLIC_API_URL', value: 'https://api-${namingSuffix}.azurewebsites.net/api/v1' }
      ]
    }
    httpsOnly: true
  }
}

// =============================================================================
// Outputs
// =============================================================================

output webAppName string = webApp.name
output apiAppName string = apiApp.name
output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output apiAppUrl string = 'https://${apiApp.properties.defaultHostName}'
output webAppPrincipalId string = webApp.identity.principalId
output apiAppPrincipalId string = apiApp.identity.principalId
