// =============================================================================
// VoiceForge AI — Main Azure Infrastructure (Bicep)
// =============================================================================
// Deploys the full stack: ACR, PostgreSQL, Redis, App Service Plan, Web Apps.
// ---------------------------------------------------------------------------

@description('Azure region for resources')
param location string = resourceGroup().location

@description('Environment name: dev, staging, prod')
@allowed(['dev', 'staging', 'prod'])
param environmentName string = 'dev'

@description('Base name for all resources (e.g., voiceforge)')
param appName string = 'voiceforge'

@description('PostgreSQL admin username')
param postgresAdminUser string = 'voiceforgeadmin'

@description('PostgreSQL admin password')
@secure()
param postgresAdminPassword string

@description('Container image tag to deploy')
param imageTag string = 'latest'

// =============================================================================
// Naming & tags
// =============================================================================
var namingSuffix = '${appName}-${environmentName}'
var tags = {
  app: appName
  environment: environmentName
  managedBy: 'bicep'
}

// =============================================================================
// Modules
// =============================================================================

module acr 'modules/acr.bicep' = {
  name: 'acrDeploy'
  params: {
    location: location
    acrName: 'acr${uniqueString(resourceGroup().id)}${environmentName}'
    tags: tags
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgresDeploy'
  params: {
    location: location
    serverName: '${appName}-pg-${environmentName}'
    adminUser: postgresAdminUser
    adminPassword: postgresAdminPassword
    databaseName: 'voiceforge'
    tags: tags
  }
}

module redis 'modules/redis.bicep' = {
  name: 'redisDeploy'
  params: {
    location: location
    redisName: '${appName}-redis-${environmentName}'
    tags: tags
  }
}

module appService 'modules/appService.bicep' = {
  name: 'appServiceDeploy'
  params: {
    location: location
    namingSuffix: namingSuffix
    acrLoginServer: acr.outputs.loginServer
    postgresHost: postgres.outputs.fqdn
    postgresDatabase: postgres.outputs.databaseName
    postgresUser: postgresAdminUser
    postgresPassword: postgresAdminPassword
    redisHost: redis.outputs.hostName
    redisKey: redis.outputs.primaryKey
    imageTag: imageTag
    tags: tags
  }
  dependsOn: [
    acr
    postgres
    redis
  ]
}

// =============================================================================
// Outputs
// =============================================================================

output acrLoginServer string = acr.outputs.loginServer
output webAppUrl string = appService.outputs.webAppUrl
output apiAppUrl string = appService.outputs.apiAppUrl
output postgresFqdn string = postgres.outputs.fqdn
output redisHost string = redis.outputs.hostName
