# =============================================================================
# Variables
# =============================================================================

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "eastus"
}

variable "app_name" {
  description = "Base name prefix for all resources"
  type        = string
  default     = "voiceforge"
}

variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default = {
    managed_by = "terraform"
    project    = "voiceforge-ai"
  }
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------
variable "vnet_address_space" {
  description = "CIDR block for the virtual network"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_address_prefix" {
  description = "CIDR block for the VM subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed for SSH inbound (restrict to your office/VPN IP in prod)"
  type        = string
  default     = "0.0.0.0/0"
}

# ---------------------------------------------------------------------------
# Virtual Machine
# ---------------------------------------------------------------------------
variable "vm_size" {
  description = "Azure VM SKU"
  type        = string
  default     = "Standard_B2s"
}

variable "vm_admin_username" {
  description = "Admin username for the VM"
  type        = string
  default     = "azureuser"
}

variable "vm_ssh_public_key" {
  description = "SSH public key for VM admin user"
  type        = string
}

variable "vm_os_disk_size_gb" {
  description = "OS disk size in GB"
  type        = number
  default     = 64
}

# ---------------------------------------------------------------------------
# Database — PostgreSQL Flexible Server
# ---------------------------------------------------------------------------
variable "postgres_admin_username" {
  description = "PostgreSQL admin username"
  type        = string
  default     = "voiceforgeadmin"
}

variable "postgres_admin_password" {
  description = "PostgreSQL admin password"
  type        = string
  sensitive   = true
}

variable "postgres_sku_name" {
  description = "PostgreSQL SKU name"
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  description = "PostgreSQL storage size in MB"
  type        = number
  default     = 32768
}

variable "postgres_backup_retention_days" {
  description = "Backup retention days"
  type        = number
  default     = 7
}

variable "postgres_geo_redundant_backup_enabled" {
  description = "Enable geo-redundant backups (recommended for prod)"
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Cache — Azure Redis
# ---------------------------------------------------------------------------
variable "redis_sku_name" {
  description = "Redis SKU name (Basic, Standard, Premium)"
  type        = string
  default     = "Basic"
}

variable "redis_family" {
  description = "Redis family (C for Basic/Standard, P for Premium)"
  type        = string
  default     = "C"
}

variable "redis_capacity" {
  description = "Redis capacity (0 = 250MB, 1 = 1GB, etc.)"
  type        = number
  default     = 0
}

# ---------------------------------------------------------------------------
# Observability
# ---------------------------------------------------------------------------
variable "log_analytics_sku" {
  description = "Log Analytics Workspace SKU"
  type        = string
  default     = "PerGB2018"
}

variable "log_retention_days" {
  description = "Log retention in days"
  type        = number
  default     = 30
}

variable "alert_email" {
  description = "Email address for monitoring alerts"
  type        = string
  default     = ""
}
