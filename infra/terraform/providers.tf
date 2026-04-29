# =============================================================================
# VoiceForge AI — Terraform Providers & Backend
# =============================================================================
# Usage:
#   cd infra/terraform
#   terraform init
#   terraform plan -var-file="staging.tfvars"
#   terraform apply -var-file="staging.tfvars"
#
# IMPORTANT: For production, configure a remote backend (Azure Storage):
#   terraform {
#     backend "azurerm" {
#       resource_group_name  = "voiceforge-tfstate-rg"
#       storage_account_name = "vftfstateprod"
#       container_name       = "tfstate"
#       key                  = "prod.terraform.tfstate"
#     }
#   }
# =============================================================================

terraform {
  required_version = ">= 1.8.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
  }
}
