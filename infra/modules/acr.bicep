// =============================================================================
// Module: Azure Container Registry
// =============================================================================

@description('Azure region')
param location string

@description('Globally unique ACR name (lowercase, alphanumeric)')
param acrName string

@description('Resource tags')
param tags object = {}

// Premium SKU supports geo-replication and private endpoints if needed later
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    adminUserEnabled: true // Required for App Service pull without MSI (simpler for first deploy)
  }
}

output loginServer string = acr.properties.loginServer
output name string = acr.name
