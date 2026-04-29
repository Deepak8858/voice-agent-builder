# =============================================================================
# Outputs
# =============================================================================

output "resource_group_name" {
  description = "Name of the deployed resource group"
  value       = azurerm_resource_group.main.name
}

output "vm_public_ip_address" {
  description = "Public IP address of the application VM"
  value       = azurerm_public_ip.vm.ip_address
}

output "vm_fqdn" {
  description = "FQDN of the application VM (if DNS label is set)"
  value       = azurerm_public_ip.vm.fqdn
}

output "postgresql_fqdn" {
  description = "PostgreSQL Flexible Server FQDN"
  value       = azurerm_postgresql_flexible_server.main.fqdn
  sensitive   = true
}

output "redis_hostname" {
  description = "Redis cache hostname"
  value       = azurerm_redis_cache.main.hostname
}

output "application_insights_name" {
  description = "Application Insights resource name"
  value       = azurerm_application_insights.main.name
}

output "application_insights_connection_string" {
  description = "Application Insights connection string (inject into API runtime)"
  value       = azurerm_application_insights.main.connection_string
  sensitive   = true
}

output "key_vault_uri" {
  description = "Key Vault URI for secret retrieval"
  value       = azurerm_key_vault.main.vault_uri
}

output "log_analytics_workspace_id" {
  description = "Log Analytics Workspace ID"
  value       = azurerm_log_analytics_workspace.main.workspace_id
}
