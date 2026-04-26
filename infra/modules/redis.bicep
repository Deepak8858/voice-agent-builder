// =============================================================================
// Module: Azure Cache for Redis (Enterprise or Standard)
// =============================================================================
// Using Standard SKU for BullMQ (supports Redis Streams needed by BullMQ).
// ---------------------------------------------------------------------------

@description('Azure region')
param location string

@description('Redis cache name (globally unique)')
param redisName string

@description('Resource tags')
param tags object = {}

@description('SKU name')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Standard'

@description('Cache family')
param family string = 'C'

@description('Cache capacity (0 = 250MB, 1 = 1GB, etc.)')
param capacity int = 0

resource redis 'Microsoft.Cache/redis@2024-03-01' = {
  name: redisName
  location: location
  tags: tags
  properties: {
    sku: {
      name: skuName
      family: family
      capacity: capacity
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    redisConfiguration: {
      'maxmemory-reserved': '30'
      'maxfragmentationmemory-reserved': '30'
      'maxmemory-delta': '30'
    }
  }
}

output hostName string = redis.properties.hostName
output primaryKey string = redis.listKeys().primaryKey
output sslPort int = redis.properties.sslPort
