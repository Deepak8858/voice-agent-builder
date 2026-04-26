param name string
param location string
param tags object
param sku object = {
  name: 'Basic'
  family: 'C'
  capacity: 0
}

resource redis 'Microsoft.Cache/redis@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: sku
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    redisConfiguration: {
      'maxmemory-policy': 'allkeys-lru'
    }
  }
}

output id string = redis.id
output hostName string = redis.properties.hostName
output primaryKey string = redis.listKeys().primaryKey
output name string = redis.name
