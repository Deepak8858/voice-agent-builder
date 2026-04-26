// =============================================================================
// Module: Azure Database for PostgreSQL Flexible Server
// =============================================================================

@description('Azure region')
param location string

@description('PostgreSQL server name (globally unique DNS prefix)')
param serverName string

@description('Admin username')
param adminUser string

@description('Admin password')
@secure()
param adminPassword string

@description('Database to create')
param databaseName string = 'voiceforge'

@description('Resource tags')
param tags object = {}

@description('PostgreSQL version')
param postgresVersion string = '16'

@description('SKU tier')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string = 'Burstable'

@description('SKU name')
param skuName string = 'Standard_B1ms'

@description('Storage size in GB')
param storageSizeGB int = 32

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    tier: skuTier
    name: skuName
  }
  properties: {
    version: postgresVersion
    administratorLogin: adminUser
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: databaseName
  properties: {}
}

// Allow Azure services (App Service) to reach PostgreSQL without public IP whitelisting
resource firewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: postgresServer
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output fqdn string = postgresServer.properties.fullyQualifiedDomainName
output databaseName string = databaseName
output serverName string = postgresServer.name
