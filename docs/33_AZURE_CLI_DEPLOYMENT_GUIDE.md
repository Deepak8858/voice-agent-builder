# 33 — Azure CLI Deployment Guide (VoiceForge AI on Azure VM)

> **Purpose:** A single, self-contained reference for provisioning, deploying, and operating VoiceForge AI on Azure using only the **Azure CLI** (no Terraform needed). Use this if you prefer imperative provisioning, quick demos, or scripting fleet deployments.

---

## Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Account & Environment Setup](#3-account--environment-setup)
4. [Resource Group & Networking](#4-resource-group--networking)
5. [Data Layer (PostgreSQL + Redis)](#5-data-layer-postgresql--redis)
6. [Observability (Key Vault, Log Analytics, App Insights)](#6-observability-key-vault-log-analytics-app-insights)
7. [Virtual Machine Provisioning](#7-virtual-machine-provisioning)
8. [VM Bootstrap (Docker, Nginx, Security)](#8-vm-bootstrap-docker-nginx-security)
9. [Secrets & Environment Configuration](#9-secrets--environment-configuration)
10. [Deploy the Application Stack](#10-deploy-the-application-stack)
11. [CI/CD Integration (GitHub Actions + Azure DevOps)](#11-cicd-integration-github-actions--azure-devops)
12. [Day-2 Operations (Updates, Backups, Troubleshooting)](#12-day-2-operations-updates-backups-troubleshooting)
13. [Scaling Path](#13-scaling-path)
14. [Cost Reference](#14-cost-reference)
15. [Security Checklist](#15-security-checklist)

---

## 1. Prerequisites

| Tool | Install Link | Verify |
|---|---|---|
| Azure CLI | https://aka.ms/installazurecli | `az --version` |
| OpenSSH Client | Built-in (Win/macOS/Linux) | `ssh -V` |
| Docker Desktop | https://docker.com/products/docker-desktop | `docker --version` |
| Git | https://git-scm.com | `git --version` |
| `jq` (JSON parser) | `apt install jq` / `brew install jq` / `choco install jq` | `jq --version` |

**You must have:**
- An active Azure subscription (`az login`)
- Owner or Contributor access on the target subscription
- A GitHub account with a Classic PAT or fine-grained token (`read:packages` scope) for GHCR
- A domain name (optional, for custom SSL with Let's Encrypt)

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Azure Resource Group                              │
│                                                                      │
│  ┌──────────────┐     ┌──────────────────────────────────────┐      │
│  │ Public IP    │────▶│ Ubuntu 22.04 VM                      │      │
│  │ (Standard)   │     │  ┌─────────┐  ┌─────┐  ┌─────────┐  │      │
│  └──────────────┘     │  │  Nginx  │─▶│ Web │  │   API   │  │      │
│                       │  │ :80/:443│  │:3000│  │  :4000  │  │      │
│                       │  └─────────┘  └─────┘  └─────────┘  │      │
│                       └──────────────────────────────────────┘      │
│                                      │                               │
│  ┌──────────────┐  ┌──────────────┐  │  ┌──────────────────────┐     │
│  │PG Flex Server│  │ Azure Redis  │◀─┘  │    Key Vault         │     │
│  │   (SSL)      │  │   (SSL)      │     │  (Secrets + TLS)     │     │
│  └──────────────┘  └──────────────┘     └──────────────────────┘     │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Log Analytics Workspace + Application Insights + Alerts     │    │
│  └──────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Account & Environment Setup

### 3.1 Login
```bash
az login
az account set --subscription "YOUR-SUBSCRIPTION-NAME-OR-ID"
```

### 3.2 Define Environment Variables
```bash
# Core naming
export APP_NAME="voiceforge"
export ENV="staging"          # dev | staging | prod
export LOCATION="eastus"
export RG="${APP_NAME}-${ENV}-rg"

# VM config
export VM_NAME="${APP_NAME}-${ENV}-vm"
export VM_SIZE="Standard_B2s"   # staging; use Standard_D2s_v3 for prod
export ADMIN_USER="azureuser"
export SSH_KEY_PATH="$HOME/.ssh/voiceforge_${ENV}_rsa"

# Domain (optional — for Let's Encrypt)
export DOMAIN="app.yourdomain.com"

# Database
export PG_USER="voiceforgeadmin"
export PG_DB="voiceforge"

# GitHub
export GHCR_USER="your-github-username"
export GHCR_TOKEN="ghp_your_personal_access_token"
```

### 3.3 Generate SSH Key (one time per environment)
```bash
ssh-keygen -t rsa -b 4096 -f "$SSH_KEY_PATH" -N "" -C "voiceforge-${ENV}"
export SSH_PUBLIC_KEY=$(cat "${SSH_KEY_PATH}.pub")
```

---

## 4. Resource Group & Networking

### 4.1 Resource Group
```bash
az group create --name "$RG" --location "$LOCATION"
```

### 4.2 Virtual Network & Subnet
```bash
az network vnet create \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-vnet" \
  --address-prefix 10.0.0.0/16 \
  --subnet-name vm-subnet \
  --subnet-prefix 10.0.1.0/24
```

### 4.3 Network Security Group (NSG)
```bash
az network nsg create \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-vm-nsg"

# Allow SSH (RESTRICT TO YOUR IP IN PRODUCTION)
az network nsg rule create \
  --resource-group "$RG" \
  --nsg-name "${APP_NAME}-${ENV}-vm-nsg" \
  --name AllowSSH \
  --priority 100 \
  --source-address-prefixes "$(curl -s ifconfig.me)/32" \
  --destination-port-ranges 22 \
  --access Allow \
  --protocol Tcp \
  --direction Inbound

# Allow HTTP
az network nsg rule create \
  --resource-group "$RG" \
  --nsg-name "${APP_NAME}-${ENV}-vm-nsg" \
  --name AllowHTTP \
  --priority 200 \
  --source-address-prefixes "*" \
  --destination-port-ranges 80 \
  --access Allow --protocol Tcp --direction Inbound

# Allow HTTPS
az network nsg rule create \
  --resource-group "$RG" \
  --nsg-name "${APP_NAME}-${ENV}-vm-nsg" \
  --name AllowHTTPS \
  --priority 210 \
  --source-address-prefixes "*" \
  --destination-port-ranges 443 \
  --access Allow --protocol Tcp --direction Inbound

# Deny all other inbound
az network nsg rule create \
  --resource-group "$RG" \
  --nsg-name "${APP_NAME}-${ENV}-vm-nsg" \
  --name DenyAllInbound \
  --priority 4096 \
  --source-address-prefixes "*" \
  --destination-port-ranges "*" \
  --access Deny --protocol "*" --direction Inbound
```

### 4.4 Public IP & NIC
```bash
az network public-ip create \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-vm-pip" \
  --sku Standard \
  --allocation-method Static \
  --dns-name "${APP_NAME}-${ENV}-app"

az network nic create \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-vm-nic" \
  --vnet-name "${APP_NAME}-${ENV}-vnet" \
  --subnet vm-subnet \
  --network-security-group "${APP_NAME}-${ENV}-vm-nsg" \
  --public-ip-address "${APP_NAME}-${ENV}-vm-pip"
```

### 4.5 Save Public IP for Later
```bash
export VM_IP=$(az network public-ip show \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-vm-pip" \
  --query ipAddress -o tsv)
echo "VM Public IP: $VM_IP"
```

---

## 5. Data Layer (PostgreSQL + Redis)

### 5.1 Generate Secure Passwords
```bash
export PG_ADMIN_PASSWORD=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32)
echo "PG Admin Password: $PG_ADMIN_PASSWORD (SAVE THIS SECURELY)"
```

### 5.2 PostgreSQL Flexible Server
```bash
az postgres flexible-server create \
  --resource-group "$RG" \
  --name "${APP_NAME}-pg-${ENV}" \
  --location "$LOCATION" \
  --version 16 \
  --admin-user "$PG_USER" \
  --admin-password "$PG_ADMIN_PASSWORD" \
  --database-name "$PG_DB" \
  --sku-name "B_Standard_B1ms" \
  --storage-size 32 \
  --tier Burstable \
  --public-access "0.0.0.0-255.255.255.255" \
  --backup-retention 7 \
  --geo-redundant-backup Disabled \
  --zone 1

# Allow only the VM public IP (more secure than 0.0.0.10)
az postgres flexible-server firewall-rule create \
  --resource-group "$RG" \
  --name "${APP_NAME}-pg-${ENV}" \
  --rule-name AllowVMAccess \
  --start-ip-address "$VM_IP" \
  --end-ip-address "$VM_IP"

# Get connection details
export PG_FQDN=$(az postgres flexible-server show \
  --resource-group "$RG" \
  --name "${APP_NAME}-pg-${ENV}" \
  --query fullyQualifiedDomainName -o tsv)
echo "PostgreSQL FQDN: $PG_FQDN"
```

### 5.3 Azure Cache for Redis
```bash
az redis create \
  --resource-group "$RG" \
  --name "${APP_NAME}-redis-${ENV}" \
  --location "$LOCATION" \
  --sku Basic \
  --vm-size c0 \
  --minimum-tls-version 1.2 \
  --enable-non-ssl-port false

export REDIS_HOST=$(az redis show \
  --resource-group "$RG" \
  --name "${APP_NAME}-redis-${ENV}" \
  --query hostName -o tsv)
export REDIS_KEY=$(az redis list-keys \
  --resource-group "$RG" \
  --name "${APP_NAME}-redis-${ENV}" \
  --query primaryKey -o tsv)
echo "Redis Host: $REDIS_HOST"
```

---

## 6. Observability (Key Vault, Log Analytics, App Insights)

### 6.1 Log Analytics Workspace
```bash
az monitor log-analytics workspace create \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-logs" \
  --location "$LOCATION" \
  --sku PerGB2018 \
  --retention-time 30

export LAW_ID=$(az monitor log-analytics workspace show \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-logs" \
  --query id -o tsv)
export LAW_WORKSPACE_ID=$(az monitor log-analytics workspace show \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-logs" \
  --query customerId -o tsv)
```

### 6.2 Application Insights
```bash
az monitor app-insights component create \
  --resource-group "$RG" \
  --app "${APP_NAME}-${ENV}-appinsights" \
  --location "$LOCATION" \
  --workspace "$LAW_ID" \
  --application-type Node.JS

export APPINSIGHTS_NAME="${APP_NAME}-${ENV}-appinsights"
export APPINSIGHTS_CS=$(az monitor app-insights component show \
  --resource-group "$RG" \
  --app "$APPINSIGHTS_NAME" \
  --query connectionString -o tsv)
echo "App Insights Connection String saved."
```

### 6.3 Key Vault
```bash
export TENANT_ID=$(az account show --query tenantId -o tsv)
export KV_NAME="${APP_NAME}${ENV}kv"

az keyvault create \
  --resource-group "$RG" \
  --name "$KV_NAME" \
  --location "$LOCATION" \
  --sku standard \
  --enable-purge-protection true \
  --enable-rbac-authorization true

# Grant yourself Key Vault Administrator (so you can create secrets)
export CURRENT_USER_ID=$(az ad signed-in-user show --query id -o tsv)
az role assignment create \
  --assignee "$CURRENT_USER_ID" \
  --role "Key Vault Administrator" \
  --scope $(az keyvault show --name "$KV_NAME" --query id -o tsv)

# Store application secrets
az keyvault secret set --vault-name "$KV_NAME" --name "database-url" \
  --value "postgresql://${PG_USER}:${PG_ADMIN_PASSWORD}@${PG_FQDN}:5432/${PG_DB}?schema=public&pgbouncer=true"

az keyvault secret set --vault-name "$KV_NAME" --name "direct-url" \
  --value "postgresql://${PG_USER}:${PG_ADMIN_PASSWORD}@${PG_FQDN}:5432/${PG_DB}?schema=public"

az keyvault secret set --vault-name "$KV_NAME" --name "redis-url" \
  --value "rediss://:${REDIS_KEY}@${REDIS_HOST}:6380"

az keyvault secret set --vault-name "$KV_NAME" --name "appinsights-connection-string" \
  --value "$APPINSIGHTS_CS"
```

### 6.4 Monitoring Alerts (VM CPU > 80%)
```bash
# Action Group (email)
az monitor action-group create \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-alerts" \
  --short-name "vf${ENV}alert" \
  --email-receivers email-alert=alerts@yourcompany.com

# VM CPU Alert
az monitor metrics alert create \
  --resource-group "$RG" \
  --name "${APP_NAME}-${ENV}-vm-cpu-alert" \
  --scopes "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/${VM_NAME}" \
  --condition "avg percentage cpu > 80" \
  --window-size 5m \
  --evaluation-frequency 1m \
  --action "${APP_NAME}-${ENV}-alerts" \
  --description "VM CPU exceeds 80% for 5 minutes"
```

---

## 7. Virtual Machine Provisioning

### 7.1 Create the VM with cloud-init
```bash
# Fetch cloud-init template from repo (or use inline below)
az vm create \
  --resource-group "$RG" \
  --name "$VM_NAME" \
  --location "$LOCATION" \
  --size "$VM_SIZE" \
  --nics "${APP_NAME}-${ENV}-vm-nic" \
  --image "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest" \
  --admin-username "$ADMIN_USER" \
  --ssh-key-values "$SSH_PUBLIC_KEY" \
  --os-disk-size-gb 64 \
  --os-disk-caching ReadWrite \
  --storage-sku Premium_LRS \
  --custom-data "@infra/terraform/cloud-init.tpl" \
  --assign-identity \
  --role "Key Vault Secrets User" \
  --scope $(az keyvault show --name "$KV_NAME" --query id -o tsv)

# Note: --assign-identity with --role automatically creates system-assigned identity + role assignment
```

### 7.2 Enable Boot Diagnostics
```bash
az vm boot-diagnostics enable \
  --resource-group "$RG" \
  --name "$VM_NAME"
```

### 7.3 Install Azure Monitor Agent
```bash
az vm extension set \
  --resource-group "$RG" \
  --vm-name "$VM_NAME" \
  --name AzureMonitorLinuxAgent \
  --publisher Microsoft.Azure.Monitor \
  --version 1.0
```

### 7.4 Open Port 443 if not already (NSG should cover this, but verify)
```bash
az vm open-port --resource-group "$RG" --name "$VM_NAME" --port 80,443 --priority 300
```

---

## 8. VM Bootstrap (Docker, Nginx, Security)

### 8.1 SSH into the VM
```bash
ssh -i "$SSH_KEY_PATH" "${ADMIN_USER}@${VM_IP}"
```

### 8.2 Verify Docker & Compose
```bash
sudo systemctl status docker
docker --version
docker compose version
```

### 8.3 Prepare App Directory
```bash
export APP_NAME="voiceforge"
sudo mkdir -p /opt/${APP_NAME}/infra/nginx/ssl
sudo mkdir -p /opt/${APP_NAME}/logs
# Ownership: your admin user should already be in docker group from cloud-init
sudo chown -R "${USER}:" /opt/${APP_NAME}
```

### 8.4 Copy Configuration Files from Repo
Option A — Clone directly on the VM:
```bash
cd /tmp
git clone https://github.com/YOUR_ORG/voice-agent-builder.git repo
cp repo/docker-compose.prod.yml /opt/${APP_NAME}/
cp -r repo/infra/nginx /opt/${APP_NAME}/infra/
cp repo/scripts/vm-bootstrap.sh /tmp/
chmod +x /tmp/vm-bootstrap.sh
```

Option B — Copy from local machine via SCP:
```bash
# Run THIS from your LOCAL machine terminal
scp -i "$SSH_KEY_PATH" docker-compose.prod.yml "${ADMIN_USER}@${VM_IP}:/opt/voiceforge/"
scp -i "$SSH_KEY_PATH" -r infra/nginx "${ADMIN_USER}@${VM_IP}:/opt/voiceforge/infra/"
scp -i "$SSH_KEY_PATH" scripts/vm-bootstrap.sh "${ADMIN_USER}@${VM_IP}:/tmp/"
```

### 8.5 Harden Nginx Config and Fetch Secrets
```bash
export KEY_VAULT_NAME="${APP_NAME}${ENV}kv"
export APP_NAME="voiceforge"
bash /tmp/vm-bootstrap.sh
```

This script will:
- Log in to Azure using the VM’s System-Assigned Managed Identity
- Fetch secrets from Key Vault
- Write `/opt/voiceforge/.env` with `chmod 600`

### 8.6 Authenticate Docker to GHCR
```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
```

> **Security:** This token is in memory only. Do not write it to disk. For production automation, pass it via CI/CD SSH session variables instead.

---

## 9. Secrets & Environment Configuration

### 9.1 Review and Complete `.env`
After `vm-bootstrap.sh`, verify `/opt/voiceforge/.env`. You must add runtime secrets that are NOT in Key Vault (or add them to Key Vault first):

```bash
sudo nano /opt/voiceforge/.env
```

Add at minimum:
```env
# Already populated by bootstrap script:
# DATABASE_URL, DIRECT_URL, REDIS_URL, APPLICATIONINSIGHTS_CONNECTION_STRING

# You MUST add these manually (or store them in Key Vault and extend bootstrap):
JWT_SECRET=your-random-64-char-hex
ENCRYPTION_KEY=your-random-64-char-hex
CLERK_SECRET_KEY=sk_test_...
CLERK_PUBLISHABLE_KEY=pk_test_...
OPENAI_API_KEY=sk-...
VAPI_API_KEY=...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# API behavior
ALLOWED_ORIGINS=https://${DOMAIN},https://api.${DOMAIN}
```

### 9.2 If You Added Secrets to Key Vault
```bash
# From the VM (or locally)
az keyvault secret set --vault-name "$KV_NAME" --name "jwt-secret" --value "..."
az keyvault secret set --vault-name "$KV_NAME" --name "encryption-key" --value "..."
# Then re-run bootstrap or extend the script
```

---

## 10. Deploy the Application Stack

### 10.1 Pull and Start Containers
```bash
cd /opt/voiceforge

# Export the Compose interpolation variables
export GITHUB_REPOSITORY_OWNER="your-github-org-or-username"
export IMAGE_TAG="latest"   # or a specific SHA if testing

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans
```

### 10.2 Verify Health
```bash
# API health
curl -sf http://localhost:4000/health && echo "API OK"

# Web health (through Nginx)
curl -sf -o /dev/null http://localhost:80/api/health && echo "Web OK (via Nginx)"

# View logs
docker compose -f docker-compose.prod.yml logs -f --tail 100
```

### 10.3 Prune Old Images
```bash
docker image prune -af --filter "until=168h"
```

---

## 11. CI/CD Integration (GitHub Actions + Azure DevOps)

Once your VM is running, the CI/CD pipelines are fully automated.

### 11.1 GitHub Actions (`.github/workflows/ci-cd-vm.yml`)

**Required Repository Secrets:**
| Secret | Description |
|---|---|
| `AZURE_VM_HOST` | `$VM_IP` (or domain) |
| `AZURE_VM_USER` | `$ADMIN_USER` |
| `AZURE_VM_SSH_KEY` | Contents of `$SSH_KEY_PATH` (private key) |
| `GITHUB_TOKEN` | Auto-injected by GitHub |

**Required Repository Variables:**
| Variable | Example |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://yourdomain.com/api/v1` |
| `NEXT_PUBLIC_APP_URL` | `https://yourdomain.com` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` | `/dashboard` |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` | `/dashboard` |

**Required Repository Secrets (Build-time):**
| Secret | Description |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (public but baked at build) |

**Trigger:**
- Push to `main` → deploys production VM
- Push to `staging` → deploys staging VM
- Manual dispatch with environment selector

### 11.2 Azure DevOps (`azure-pipelines.yml`)

Create in Azure DevOps:
1. **Service Connection → Docker Registry** named `github-service-connection`
   - Registry type: `Docker Hub` or `Others`, Server: `https://ghcr.io`, Username: `$GHCR_USER`, Password: `$GHCR_TOKEN`
2. **SSH Service Connections** for staging and production VMs.
3. **Variable Groups:**
   - `voiceforge-common` → `NEXT_PUBLIC_*` vars
   - `voiceforge-staging-secrets` → runtime secrets for staging
   - `voiceforge-prod-secrets` → runtime secrets for production

---

## 12. Day-2 Operations (Updates, Backups, Troubleshooting)

### 12.1 Update the Stack (New Release)

**Manual (from VM):**
```bash
cd /opt/voiceforge
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans
```

**Via CI/CD:** Push to `main` or run the GitHub Actions workflow manually.

### 12.2 Backup & Restore

**PostgreSQL (automated by Azure):**
```bash
# Verify backup retention
az postgres flexible-server show \
  --resource-group "$RG" \
  --name "${APP_NAME}-pg-${ENV}" \
  --query backup.backupRetentionDays

# Trigger on-demand backup ( geo-redundant snapshot )
az postgres flexible-server backup create \
  --resource-group "$RG" \
  --name "${APP_NAME}-pg-${ENV}" \
  --backup-name "pre-migration-$(date +%s)"
```

**VM Disk (Azure Backup Vault):**
```bash
# Create vault
az backup vault create --resource-group "$RG" --name "${APP_NAME}-${ENV}-bv" --location "$LOCATION"
# Enable backup for VM
az backup protection enable-for-vm \
  --resource-group "$RG" \
  --vault-name "${APP_NAME}-${ENV}-bv" \
  --vm "$VM_NAME" \
  --policy-name DefaultPolicy
```

### 12.3 Scale the VM Vertically
```bash
# Resize VM (requires stop/start)
az vm deallocate --resource-group "$RG" --name "$VM_NAME"
az vm resize --resource-group "$RG" --name "$VM_NAME" --size Standard_D2s_v3
az vm start --resource-group "$RG" --name "$VM_NAME"
```

### 12.4 View Logs via Azure CLI
```bash
# Stream VM serial logs
az vm boot-diagnostics get-boot-log --resource-group "$RG" --name "$VM_NAME"

# Query Log Analytics for container logs
az monitor log-analytics query \
  --workspace "$LAW_WORKSPACE_ID" \
  --analytics-query "ContainerLog | where ContainerName contains 'vf-' | order by TimeGenerated desc | take 100"
```

### 12.5 Troubleshooting Quick Reference

| Symptom | Diagnosis | Fix |
|---|---|---|
| `docker login ghcr.io` fails | PAT expired / wrong scope | Regenerate GitHub PAT with `read:packages` |
| `curl localhost:4000/health` fails | API container not running or crashed | `docker compose logs api` |
| `curl localhost:80/api/health` fails | Nginx not proxying to API | Check `infra/nginx/nginx.conf`, verify `api` container name resolves |
| Nginx 502 | API not accepting connections on port 4000 | Ensure API `API_PORT=4000` and binding `0.0.0.0` |
| Database connection refused | NSG or PG firewall blocking VM IP | Re-run VM IP firewall rule creation (Step 5.2) |
| `NEXT_PUBLIC_*` vars wrong | Next.js standalone built with old values | Re-run CI/CD to rebuild web image |
| High CPU/memory | Under-provisioned VM or memory leak | Resize VM or check `docker stats` / Log Analytics |
| Terraform state locked | Concurrent apply or stale lock | `az storage blob lease break --blob-url <STATE_BLOB_URL>` | (if using remote backend)

---

## 13. Scaling Path

| Phase | Architecture | Trigger |
|---|---|---|
| **1. Single VM** (Current) | B2s/D2s_v3 + Docker Compose | Staging / MVP (< 1k daily calls) |
| **2. VM Scale Set** | Uniform VMSS + Azure Load Balancer | Need horizontal redundancy without K8s |
| **3. AKS** | Azure Kubernetes Service + Ingress-NGINX | Complex deployments, auto-scaling, multi-region |

To scale horizontally later:
1. Move from Azure VM to **Azure VM Scale Set** (`az vmss create`).
2. Place **Azure Load Balancer** in front.
3. Ensure sessions are stateless (use Redis for session/cache).
4. Use **Azure Database for PostgreSQL read replicas** for query scaling.

---

## 14. Cost Reference

| Resource | SKU | ~Monthly (Staging) |
|---|---|---|
| VM | Standard_B2s | $30 |
| OS Disk | 64 GB Premium SSD | $10 |
| PostgreSQL | B_Standard_B1ms (Burstable) | $13 |
| Redis | Basic C0 | $16 |
| Public IP | Standard Static | $3 |
| Log Analytics | Pay-as-you-go (1 GB/day) | $20 |
| Key Vault | Standard | ~$1 |
| **Total** | | **~$93/mo** |

---

## 15. Security Checklist

- [ ] `allowed_ssh_cidr` restricted to your office/VPN IP (not `0.0.0.0/0`)
- [ ] PostgreSQL firewall allows **only** the VM IP
- [ ] Redis non-SSL port disabled (`enable-non-ssl-port false`)
- [ ] Secrets stored in **Key Vault** — never in `.env` files in CI logs
- [ ] `.env` on VM has `chmod 600`
- [ ] GHCR PAT has **minimal scope** (`read:packages`) and expiry < 90 days
- [ ] Nginx security headers active (HSTS, CSP, X-Frame-Options)
- [ ] VM auto-upgrades enabled (unattended-upgrades)
- [ ] Backup retention configured (PostgreSQL + Azure Backup Vault)
- [ ] Alerts configured for CPU, memory, database storage
- [ ] API `/health` endpoint monitored by Nginx + CI smoke tests
- [ ] Webhook secrets (Stripe, Vapi, Clerk) validated in application code

---

> **Next Step:** Run the commands in **Sections 3–7** from your local terminal to provision the infrastructure, then follow **Sections 8–10** on the VM to deploy the application. Once verified, configure CI/CD (Section 11) for push-to-deploy automation.
