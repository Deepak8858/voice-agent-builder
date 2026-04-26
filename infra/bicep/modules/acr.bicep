param name string
param location string
param tags object
param adminUserEnabled bool = false
param sku string = 'Standard'

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: adminUserEnabled
    networkRuleBypassOptions: 'AzureServices'
  }
}

output id string = acr.id
output loginServer string = acr.properties.loginServer
output name string = acr.name
