targetScope = 'resourceGroup'

@allowed(['staging', 'production'])
param environment string
param location string = resourceGroup().location
param tags object = {
  app: 'voiceforge-ai'
  environment: environment
}

// Container Registry
param acrName string = 'vf${uniqueString(resourceGroup().id)}acr'
param acrAdminUserEnabled bool = true

// ACR credentials helper
resource acrResource 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acr.outputs.name
}

// Container Apps
param apiImage string
param webImage string
param apiContainerAppName string = 'vf-api-${environment}'
param webContainerAppName string = 'vf-web-${environment}'
param containerCpu string = '1.0'
param containerMemory string = '2.0Gi'

// Postgres
param postgresServerName string = 'vf-pg-${uniqueString(resourceGroup().id)}-${environment}'
param postgresAdminUser string = 'voiceforge'
@secure()
param postgresAdminPassword string = newGuid()
param postgresSku object = environment == 'production'
  ? { name: 'Standard_D2s_v3', tier: 'GeneralPurpose' }
  : { name: 'Standard_B1ms', tier: 'Burstable' }
param postgresStorageGB int = 32
param postgresVersion string = '16'

// Redis
param redisName string = 'vf-redis-${uniqueString(resourceGroup().id)}-${environment}'
param redisSku object = environment == 'production'
  ? { name: 'Standard', family: 'C', capacity: 1 }
  : { name: 'Basic', family: 'C', capacity: 0 }

// Secrets passed through to Container Apps
@secure()
param databaseUrl string
@secure()
param directUrl string
@secure()
param redisUrl string
@secure()
param jwtSecret string
@secure()
param encryptionKey string
@secure()
param clerkSecretKey string
@secure()
param clerkPublishableKey string
@secure()
param openaiApiKey string
@secure()
param vapiApiKey string

// ---------------------------------------------------------------
// Log Analytics
// ---------------------------------------------------------------
module law './modules/logAnalytics.bicep' = {
  name: 'lawDeploy'
  params: {
    name: 'vf-law-${environment}'
    location: location
    tags: tags
  }
}

// ---------------------------------------------------------------
// ACR
// ---------------------------------------------------------------
module acr './modules/acr.bicep' = {
  name: 'acrDeploy'
  params: {
    name: acrName
    location: location
    tags: tags
    adminUserEnabled: acrAdminUserEnabled
  }
}

// ---------------------------------------------------------------
// Container Apps Environment
// ---------------------------------------------------------------
module env './modules/containerAppsEnvironment.bicep' = {
  name: 'envDeploy'
  params: {
    name: 'vf-env-${environment}'
    location: location
    tags: tags
    logAnalyticsWorkspaceId: law.outputs.id
  }
}

// ---------------------------------------------------------------
// PostgreSQL Flexible Server
// ---------------------------------------------------------------
module postgres './modules/postgres.bicep' = {
  name: 'postgresDeploy'
  params: {
    serverName: postgresServerName
    location: location
    tags: tags
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresAdminPassword
    sku: postgresSku
    storageGB: postgresStorageGB
    postgresVersion: postgresVersion
  }
}

// ---------------------------------------------------------------
// Azure Cache for Redis
// ---------------------------------------------------------------
module redis './modules/redis.bicep' = {
  name: 'redisDeploy'
  params: {
    name: redisName
    location: location
    tags: tags
    sku: redisSku
  }
}

// ---------------------------------------------------------------
// API Container App
// ---------------------------------------------------------------
module apiApp './modules/containerApp.bicep' = {
  name: 'apiAppDeploy'
  params: {
    name: apiContainerAppName
    location: location
    tags: tags
    containerAppsEnvironmentId: env.outputs.id
    containerRegistryLoginServer: acr.outputs.loginServer
    containerRegistryPassword: acrAdminUserEnabled ? acrResource.listCredentials().passwords[0].value : ''
    image: apiImage
    cpu: containerCpu
    memory: containerMemory
    envVars: [
      { name: 'NODE_ENV', value: environment == 'production' ? 'production' : 'staging' }
      { name: 'API_PORT', value: '4000' }
      { name: 'DATABASE_URL', secretRef: 'database-url' }
      { name: 'DIRECT_URL', secretRef: 'direct-url' }
      { name: 'REDIS_URL', secretRef: 'redis-url' }
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'ENCRYPTION_KEY', secretRef: 'encryption-key' }
      { name: 'CLERK_SECRET_KEY', secretRef: 'clerk-secret-key' }
      { name: 'CLERK_PUBLISHABLE_KEY', secretRef: 'clerk-publishable-key' }
      { name: 'OPENAI_API_KEY', secretRef: 'openai-api-key' }
      { name: 'VAPI_API_KEY', secretRef: 'vapi-api-key' }
      { name: 'AUTH_PROVIDER', value: 'clerk' }
      { name: 'VOICE_PROVIDER', value: 'vapi' }
      { name: 'LLM_PROVIDER', value: 'openai' }
    ]
    secrets: [
      { name: 'database-url', value: databaseUrl }
      { name: 'direct-url', value: directUrl }
      { name: 'redis-url', value: redisUrl }
      { name: 'jwt-secret', value: jwtSecret }
      { name: 'encryption-key', value: encryptionKey }
      { name: 'clerk-secret-key', value: clerkSecretKey }
      { name: 'clerk-publishable-key', value: clerkPublishableKey }
      { name: 'openai-api-key', value: openaiApiKey }
      { name: 'vapi-api-key', value: vapiApiKey }
    ]
    externalIngress: true
    targetPort: 4000
  }
}

// ---------------------------------------------------------------
// Web Container App
// ---------------------------------------------------------------
module webApp './modules/containerApp.bicep' = {
  name: 'webAppDeploy'
  params: {
    name: webContainerAppName
    location: location
    tags: tags
    containerAppsEnvironmentId: env.outputs.id
    containerRegistryLoginServer: acr.outputs.loginServer
    containerRegistryPassword: acrAdminUserEnabled ? acrResource.listCredentials().passwords[0].value : ''
    image: webImage
    cpu: containerCpu
    memory: containerMemory
    // NOTE: NEXT_PUBLIC_* variables are inlined at Next.js build time.
    // They must be provided as build-args in CI (Dockerfile.web). Do not rely on runtime env.
    envVars: [
      { name: 'PORT', value: '3000' }
    ]
    secrets: []
    externalIngress: true
    targetPort: 3000
  }
}

output acrLoginServer string = acr.outputs.loginServer
output apiFqdn string = apiApp.outputs.fqdn
output webFqdn string = webApp.outputs.fqdn
output postgresHost string = postgres.outputs.fqdn
output redisHost string = redis.outputs.hostName
