# 32 — Azure VM Deployment (Terraform + GHCR + Nginx)

## Overview

This guide deploys **VoiceForge AI** onto **Azure Virtual Machines** using:
- **Terraform** for Infrastructure-as-Code (VM, networking, managed DB/redis, monitoring)
- **GitHub Container Registry (GHCR)** for Docker images
- **Nginx** reverse proxy (SSL termination, rate limiting)
- **GitHub Actions** or **Azure DevOps** for CI/CD
- **Azure Key Vault** for runtime secrets
- **Azure Monitor + Application Insights + Log Analytics** for observability

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Azure Resource Group                         │
│                                                                      │
│   ┌──────────────┐        ┌────────────────────────────────────┐    │
│   │   Public IP  │───────▶│  Ubuntu VM (Docker + Nginx)       │    │
│   └──────────────┘        │  ┌─────┐  ┌─────┐  ┌───────────┐  │    │
│                           │  │Nginx│─▶│ Web │  │    API    │  │    │
│                           │  │ :80 │  │:3000│  │   :4000   │  │    │
│                           │  │:443 │  └─────┘  └───────────┘  │    │
│                           │  └─────┘                             │    │
│                           └────────────────────────────────────┘    │
│                                    │                                 │
│   ┌──────────────────┐  ┌──────────┴──────────┐  ┌───────────────┐  │
│   │ PostgreSQL Flex  │  │  Azure Cache Redis  │  │  Key Vault    │  │
│   └──────────────────┘  └─────────────────────┘  └───────────────┘  │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │  Observability: Log Analytics + App Insights + Alerts        │  │
│   └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Azure subscription
- Terraform >= 1.8.0
- Azure CLI (`az`) authenticated
- SSH key pair (`ssh-keygen -t rsa -b 4096`)
- GitHub repository with Actions enabled (for GHCR pipeline)

## 1. Infrastructure Provisioning (Terraform)

### Configure Backend (Recommended)

Use Azure Storage for remote state:

```bash
# Create backend storage (one time)
az group create -n voiceforge-tfstate-rg -l eastus
az storage account create -n vftfstate$(az account show --query id -o tsv | md5sum | cut -c1-8) -g voiceforge-tfstate-rg -l eastus --sku Standard_LRS
az storage container create -n tfstate --account-name $(az storage account list -g voiceforge-tfstate-rg --query '[0].name' -o tsv)
```

Uncomment and configure the `backend "azurerm"` block in `infra/terraform/providers.tf`.

### Deploy

```bash
cd infra/terraform

cp staging.tfvars.example staging.tfvars
# Edit staging.tfvars with your SSH key, office IP, alert email, etc.

terraform init
terraform plan -var-file=staging.tfvars
terraform apply -var-file=staging.tfvars
```

### Post-Deploy: Bootstrap the VM

Terraform creates the VM and stores secrets in Key Vault. You must SSH to the VM once to pull secrets and start the stack:

```bash
# 1. SSH to the VM
ssh azureuser@<VM_PUBLIC_IP>

# 2. On the VM, run the bootstrap script
cd /opt/voiceforge
export KEY_VAULT_NAME="voiceforgestagingkv"  # From terraform output
export APP_NAME="voiceforge"

# The repo should be cloned or copied to /opt/voiceforge (via SCP/rsync or git clone)
git clone https://github.com/YOUR_ORG/voice-agent-builder.git /tmp/repo
cp /tmp/repo/docker-compose.prod.yml /opt/voiceforge/
cp -r /tmp/repo/infra/nginx /opt/voiceforge/infra/
chmod +x /tmp/repo/scripts/vm-bootstrap.sh
/tmp/repo/scripts/vm-bootstrap.sh

# 3. Authenticate Docker to GHCR
echo "YOUR_GHCR_PAT" | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin

# 4. Pull and start
cd /opt/voiceforge
docker compose -f docker-compose.prod.yml up -d
```

> **Security Note:** Do NOT store PATs on the VM persistently. Use a GitHub App or fine-grained token with minimal scope (`read:packages`). Rotate frequently.

## 2. CI/CD Pipelines

### GitHub Actions

Use `.github/workflows/ci-cd-vm.yml`.

**Required Secrets:**
| Secret | Description |
|--------|-------------|
| `AZURE_VM_HOST` | Public IP or FQDN of the Azure VM |
| `AZURE_VM_USER` | SSH username (e.g., `azureuser`) |
| `AZURE_VM_SSH_KEY` | Private SSH key (add public key to VM) |

**Required Variables:**
| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Full public API URL |
| `NEXT_PUBLIC_APP_URL` | Full public app URL |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |
| ... | Other `NEXT_PUBLIC_*` build-time vars |

**Trigger:** Push to `main` (production) or `staging`.

### Azure DevOps

Use `azure-pipelines.yml` at the repository root.

**Required Setup:**
1. **Service Connection** → `github-service-connection` (for GHCR login)
2. **SSH Service Connections** → `azure-vm-staging-ssh` and `azure-vm-production-ssh`
3. **Variable Groups** → `voiceforge-common`, `voiceforge-staging-secrets`, `voiceforge-prod-secrets`

**Trigger:** Push to `main` or `staging`.

## 3. Secrets Management

### Build-Time vs Runtime

| Variable Type | When Injected | Where Stored | Examples |
|---------------|---------------|--------------|----------|
| `NEXT_PUBLIC_*` | Build time | GitHub Variables / DevOps Variables | API URL, Clerk publishable key |
| Runtime secrets | Container start | Azure Key Vault → .env on VM | DATABASE_URL, JWT_SECRET, API keys |

**Rule:** `NEXT_PUBLIC_*` variables are baked into the Next.js standalone bundle at `docker build` time. They cannot be changed without rebuilding the image. Runtime secrets are read from the `.env` file on the VM and can be rotated independently.

### Rotating Secrets

1. Update the secret in **Azure Key Vault** (portal or CLI).
2. SSH to the VM and re-run `scripts/vm-bootstrap.sh` to refresh `.env`.
3. Restart containers: `docker compose -f docker-compose.prod.yml restart`.

## 4. Scaling & Production Hardening

### Horizontal Scaling

A single VM is suitable for staging/MVP. For production traffic:

1. **VM Scale Sets**: Replace the VM with `azurerm_linux_virtual_machine_scale_set`.
2. **Azure Load Balancer**: Distribute traffic across VM instances.
3. **Shared Session State**: Ensure Redis (Azure Cache) is used for sessions/queues.
4. **Database Read Replicas**: Add PostgreSQL read replicas for query scaling.

### SSL Certificates

**Option A — Let's Encrypt (recommended for VM):**
```bash
sudo certbot --nginx -d app.yourdomain.com -d api.yourdomain.com
```
Mount certificates into the Nginx container via `docker-compose.prod.yml` volumes.

**Option B — Azure Key Vault + Managed Certificate:**
Export certificate from Key Vault to PEM and mount into the container.

### Backup Strategy

| Layer | Method | Retention |
|-------|--------|-----------|
| PostgreSQL | Azure automated backups + geo-redundancy | 7–35 days |
| Redis | Azure persistence (AOF/RDB) | Per SKU |
| VM Disk | Azure Backup Vault | 30 days |
| Terraform State | Azure Blob Storage versioning | 90 days |

## 5. Observability Cheat Sheet

| Tool | Purpose | Query/URL |
|------|---------|-----------|
| Azure Monitor Metrics | VM CPU, memory, disk | Portal → VM → Monitoring |
| Log Analytics | Container logs, syslogs | `ContainerLog` table in Logs |
| Application Insights | APM, distributed tracing | `requests`, `exceptions` tables |
| Alerts | Email/Teams on thresholds | Portal → Monitor → Alerts |

### Useful Log Analytics Queries

```kusto
// Container logs from Docker
ContainerLog
| where ContainerName contains "vf-"
| order by TimeGenerated desc
| take 100

// Application exceptions
exceptions
| order by timestamp desc
| take 50

// API request latency
requests
| where cloud_RoleName == "voiceforge-api"
| summarize avg(duration), percentile(duration, 95) by bin(timestamp, 5m)
| render timechart
```

## 6. Cost Estimate (Staging)

| Resource | SKU | ~Monthly Cost |
|----------|-----|---------------|
| VM | Standard_B2s | $30 |
| PostgreSQL | B_Standard_B1ms | $13 |
| Redis | Basic C0 | $16 |
| Log Analytics | Pay-as-you-go | $5–20 |
| Key Vault | Standard | $0.03/10K ops |
| Public IP | Standard | $3 |
| **Total** | | **~$70–90** |

Production (D2s_v3, Standard C1, GP PostgreSQL): ~$200–350/month.

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `docker login ghcr.io` fails | PAT expired or lacks `read:packages` scope |
| Database connection refused | Check PostgreSQL firewall rules; VM IP must be allowed |
| Nginx 502 Bad Gateway | API container down; check `docker compose logs api` |
| NEXT_PUBLIC vars missing | They are build-time only — rebuild image via CI/CD |
| High CPU / memory | Scale VM SKU or add replicas; check Log Analytics for culprit |
| Terraform state lock | Run `terraform force-unlock <LOCK_ID>` or clear blob lease |
