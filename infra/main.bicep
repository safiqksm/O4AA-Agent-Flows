// Azure infrastructure for the Okta XAA Agent Flows demo.
// Single Linux Web App (server serves the built React client + API),
// an empty Key Vault for secrets (seeded out-of-band, never in this template),
// and the RBAC role assignment letting the Web App's managed identity read it.
targetScope = 'resourceGroup'

@description('Base name used to derive resource names (web app, plan, vault).')
param baseName string = 'o4aa-agent-flows'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('App Service Plan SKU.')
param planSkuName string = 'B1'

@description('Node runtime version for the Linux Web App.')
param nodeVersion string = '20-lts'

var suffix = uniqueString(resourceGroup().id)
var webAppName = '${baseName}-${suffix}'
var planName = 'plan-${baseName}'
// Key Vault names: 3-24 chars, globally unique.
var keyVaultName = take('kv-${replace(baseName, '-', '')}-${suffix}', 24)

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  sku: {
    name: planSkuName
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|${nodeVersion}'
      appCommandLine: 'npm start'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      alwaysOn: planSkuName != 'F1' && planSkuName != 'D1'
      http20Enabled: true
      appSettings: [
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'APP_BASE_URL', value: 'https://${webAppName}.azurewebsites.net' }
        { name: 'OKTA_REDIRECT_URI', value: 'https://${webAppName}.azurewebsites.net/api/callback' }
        // Secrets — resolved from Key Vault at runtime via the Web App's managed
        // identity. Populate the underlying secrets with `az keyvault secret set`;
        // this template never contains secret values.
        { name: 'SESSION_SECRET', value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/SESSION-SECRET/)' }
        { name: 'OKTA_CLIENT_SECRET', value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/OKTA-CLIENT-SECRET/)' }
        { name: 'AGENT_PRIVATE_KEY', value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/AGENT-PRIVATE-KEY/)' }
        { name: 'SERVICE_PRIVATE_KEY', value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/SERVICE-PRIVATE-KEY/)' }
        { name: 'MCP_BASIC_PASSWORD', value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/MCP-BASIC-PASSWORD/)' }
      ]
    }
  }
}

resource logsConfig 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: webApp
  name: 'logs'
  properties: {
    applicationLogs: {
      fileSystem: {
        level: 'Information'
      }
    }
    httpLogs: {
      fileSystem: {
        enabled: true
        retentionInDays: 7
        retentionInMb: 35
      }
    }
  }
}

// Key Vault Secrets User (read-only secret access) for the Web App's identity.
resource keyVaultSecretsUserRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: subscription()
  name: '4633458b-17de-408a-b874-0445c86b69e6'
}

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, webApp.id, keyVaultSecretsUserRole.id)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole.id
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output webAppName string = webApp.name
output webAppHostName string = webApp.properties.defaultHostName
output webAppPrincipalId string = webApp.identity.principalId
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
