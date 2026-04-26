param name string
param location string
param tags object
param containerAppsEnvironmentId string
param containerRegistryLoginServer string
@secure()
param containerRegistryPassword string = ''
param image string
param cpu string = '0.5'
param memory string = '1.0Gi'
param minReplicas int = 0
param maxReplicas int = 5
param externalIngress bool = true
param targetPort int = 80

@description('Non-sensitive environment variables')
param envVars array = []

@description('Secrets stored in Container Apps (key-value)')
@secure()
param secrets array = []

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: externalIngress
        targetPort: targetPort
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      secrets: concat(
        [for s in secrets: {
          name: s.name
          value: s.value
        }],
        !empty(containerRegistryPassword)
          ? [{ name: 'acr-password', value: containerRegistryPassword }]
          : []
      )
      registries: !empty(containerRegistryPassword)
        ? [
            {
              server: containerRegistryLoginServer
              username: split(containerRegistryLoginServer, '.')[0]
              passwordSecretRef: 'acr-password'
            }
          ]
        : [
            {
              server: containerRegistryLoginServer
              identity: 'system'
            }
          ]
    }
    template: {
      revisionSuffix: uniqueString(image)
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [for v in envVars: {
            name: v.name
            value: contains(v, 'value') ? v.value : null
            secretRef: contains(v, 'secretRef') ? v.secretRef : null
          }]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                port: targetPort
                path: '/health'
              }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
            {
              type: 'Readiness'
              httpGet: {
                port: targetPort
                path: '/health'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'httpscale'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
    identity: {
      type: 'SystemAssigned'
    }
  }
}

output id string = app.id
output fqdn string = app.properties.configuration.ingress.fqdn
output name string = app.name
