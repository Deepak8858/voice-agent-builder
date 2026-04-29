# =============================================================================
# Data Layer — PostgreSQL Flexible Server & Azure Cache for Redis
# =============================================================================

# ---------------------------------------------------------------------------
# PostgreSQL Flexible Server
# ---------------------------------------------------------------------------
resource "random_password" "postgres_admin" {
  length  = 32
  special = false
}

locals {
  postgres_admin_password = var.postgres_admin_password != "" ? var.postgres_admin_password : random_password.postgres_admin.result
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                   = "${local.naming_suffix}-postgres"
  resource_group_name    = azurerm_resource_group.main.name
  location               = azurerm_resource_group.main.location
  version                = "16"
  sku_name               = var.postgres_sku_name
  storage_mb             = var.postgres_storage_mb
  backup_retention_days  = var.postgres_backup_retention_days
  geo_redundant_backup_enabled = var.postgres_geo_redundant_backup_enabled
  administrator_login    = var.postgres_admin_username
  administrator_password = local.postgres_admin_password
  zone                   = "1"
  tags                   = local.common_tags

  # High availability for production
  high_availability {
    mode = var.environment == "prod" ? "ZoneRedundant" : "Disabled"
  }

  lifecycle {
    ignore_changes = [
      high_availability[0].standby_availability_zone,
    ]
  }
}

# Allow Azure services (VM subnet) to connect
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# Optional: allow VM public IP (if not using VNet integration)
resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_vm" {
  name             = "AllowVMAccess"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = azurerm_public_ip.vm.ip_address
  end_ip_address   = azurerm_public_ip.vm.ip_address
}

# ---------------------------------------------------------------------------
# Azure Cache for Redis
# ---------------------------------------------------------------------------
resource "azurerm_redis_cache" "main" {
  name                = "${local.naming_suffix}-redis"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = var.redis_capacity
  family              = var.redis_family
  sku_name            = var.redis_sku_name
  enable_non_ssl_port = false
  minimum_tls_version = "1.2"
  tags                = local.common_tags

  redis_configuration {
    maxmemory_policy = "allkeys-lru"
  }

  # Patch schedule for production
  patch_schedule {
    day_of_week    = "Sunday"
    start_hour_utc = 2
  }
}
