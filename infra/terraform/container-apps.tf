# =============================================================================
# VoiceForge AI — Azure Container Apps Infrastructure
# =============================================================================
# Modern serverless container deployment with auto-scaling, ingress,
# and managed identity integration.
# =============================================================================

locals {
  aca_suffix = "${var.app_name}-${var.environment}"
}

# ---------------------------------------------------------------------------
# Azure Container Registry
# ---------------------------------------------------------------------------
resource "azurerm_container_registry" "main" {
  name                = "${var.app_name}${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = var.acr_sku
  admin_enabled       = true
  tags                = local.common_tags
}

# ---------------------------------------------------------------------------
# Virtual Network for ACA
# ---------------------------------------------------------------------------
resource "azurerm_virtual_network" "aca" {
  name                = "${local.aca_suffix}-vnet"
  address_space       = [var.aca_vnet_address_space]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.common_tags
}

resource "azurerm_subnet" "aca_infra" {
  name                 = "aca-infra-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.aca.name
  address_prefixes     = [var.aca_infra_subnet_prefix]

  delegation {
    name = "aca-delegation"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "aca_apps" {
  name                 = "aca-apps-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.aca.name
  address_prefixes     = [var.aca_apps_subnet_prefix]
}

# Private endpoint subnet for PostgreSQL
resource "azurerm_subnet" "private_endpoints" {
  name                 = "private-endpoints-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.aca.name
  address_prefixes     = [var.aca_pe_subnet_prefix]

  private_endpoint_network_policies_enabled = true
}

# ---------------------------------------------------------------------------
# Private DNS Zone for PostgreSQL
# ---------------------------------------------------------------------------
resource "azurerm_private_dns_zone" "postgres" {
  name                = "privatelink.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${local.aca_suffix}-postgres-link"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.aca.id
}

# ---------------------------------------------------------------------------
# Private Endpoint for PostgreSQL
# ---------------------------------------------------------------------------
resource "azurerm_private_endpoint" "postgres" {
  name                = "${local.aca_suffix}-postgres-pe"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.common_tags

  private_service_connection {
    name                           = "postgres-psc"
    private_connection_resource_id = azurerm_postgresql_flexible_server.main.id
    subresource_names              = ["postgresqlServer"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "postgres-dns-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.postgres.id]
  }
}

# ---------------------------------------------------------------------------
# Azure Container Apps Environment
# ---------------------------------------------------------------------------
resource "azurerm_container_app_environment" "main" {
  name                       = "${local.aca_suffix}-env"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  infrastructure_subnet_id   = azurerm_subnet.aca_infra.id
  internal_load_balancer_enabled = false
  logs_workspace_id          = azurerm_log_analytics_workspace.main.id
  tags                       = local.common_tags
}

# ---------------------------------------------------------------------------
# Managed Identity for Container Apps
# ---------------------------------------------------------------------------
resource "azurerm_user_assigned_identity" "aca" {
  name                = "${local.aca_suffix}-aca-identity"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.common_tags
}

# Grant ACA identity access to Key Vault
resource "azurerm_role_assignment" "aca_kv_secrets_user" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.aca.principal_id
}

# Grant ACA identity ACR pull access
resource "azurerm_role_assignment" "aca_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.aca.principal_id
}

# ---------------------------------------------------------------------------
# API Container App
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "api" {
  name                         = "${local.aca_suffix}-api"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = local.common_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aca.id]
  }

  ingress {
    external_enabled = true
    target_port      = 4000
    transport        = "http"
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.aca.id
  }

  secret {
    name  = "database-url"
    value = azurerm_key_vault_secret.database_url.value
  }

  secret {
    name  = "direct-url"
    value = azurerm_key_vault_secret.direct_url.value
  }

  secret {
    name  = "redis-url"
    value = azurerm_key_vault_secret.redis_url.value
  }

  secret {
    name  = "jwt-secret"
    value = var.jwt_secret != "" ? var.jwt_secret : random_password.jwt_secret.result
  }

  secret {
    name  = "encryption-key"
    value = var.encryption_key != "" ? var.encryption_key : random_password.encryption_key.result
  }

  template {
    container {
      name   = "api"
      image  = "${azurerm_container_registry.main.login_server}/voiceforge-api:latest"
      cpu    = var.api_cpu
      memory = var.api_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "API_PORT"
        value = "4000"
      }

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "DIRECT_URL"
        secret_name = "direct-url"
      }

      env {
        name        = "REDIS_URL"
        secret_name = "redis-url"
      }

      env {
        name        = "JWT_SECRET"
        secret_name = "jwt-secret"
      }

      env {
        name        = "ENCRYPTION_KEY"
        secret_name = "encryption-key"
      }

      env {
        name  = "AUTH_PROVIDER"
        value = "clerk"
      }

      env {
        name  = "VOICE_PROVIDER"
        value = "vapi"
      }

      env {
        name  = "LLM_PROVIDER"
        value = "openai"
      }

      env {
        name  = "EMBEDDING_PROVIDER"
        value = "openai"
      }

      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.main.connection_string
      }

      env {
        name  = "ALLOWED_ORIGINS"
        value = "https://${local.aca_suffix}-web.${azurerm_container_app_environment.main.default_domain}"
      }

      # Clerk and provider secrets should be added via Key Vault references
      # or manually via az containerapp secret set after initial deployment
    }

    min_replicas = var.api_min_replicas
    max_replicas = var.api_max_replicas
  }

  depends_on = [
    azurerm_role_assignment.aca_acr_pull,
    azurerm_role_assignment.aca_kv_secrets_user,
  ]

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
    ]
  }
}

# ---------------------------------------------------------------------------
# Web Container App (Next.js)
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "web" {
  name                         = "${local.aca_suffix}-web"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  tags                         = local.common_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aca.id]
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "http"
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.aca.id
  }

  template {
    container {
      name   = "web"
      image  = "${azurerm_container_registry.main.login_server}/voiceforge-web:latest"
      cpu    = var.web_cpu
      memory = var.web_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "PORT"
        value = "3000"
      }

      env {
        name  = "HOSTNAME"
        value = "0.0.0.0"
      }

      env {
        name  = "NEXT_PUBLIC_API_URL"
        value = "https://${azurerm_container_app.api.ingress[0].fqdn}/api/v1"
      }

      env {
        name  = "NEXT_PUBLIC_APP_URL"
        value = "https://${local.aca_suffix}-web.${azurerm_container_app_environment.main.default_domain}"
      }

      # NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY should be set via Key Vault
    }

    min_replicas = var.web_min_replicas
    max_replicas = var.web_max_replicas
  }

  depends_on = [
    azurerm_role_assignment.aca_acr_pull,
    azurerm_container_app.api,
  ]

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
    ]
  }
}

# ---------------------------------------------------------------------------
# Random passwords for runtime secrets (if not provided)
# ---------------------------------------------------------------------------
resource "random_password" "jwt_secret" {
  length  = 32
  special = false
}

resource "random_password" "encryption_key" {
  length  = 32
  special = false
}
