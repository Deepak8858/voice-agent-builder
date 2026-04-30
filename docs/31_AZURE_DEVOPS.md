# 31 — Azure DevOps & Container Apps Deployment

## Overview
This guide covers deploying **VoiceForge AI** to **Microsoft Azure** using:
- **Azure VM** (Ubuntu + Docker Compose for Web + API)
- **Azure Container Registry** (image storage)
- **Azure Database for PostgreSQL — Flexible Server** (or Supabase)
- **Azure Cache for Redis** (or co-located Redis container)
- **Azure DevOps Pipelines** for CI/CD
- **Bicep** templates for Infrastructure-as-Code (optional)

## Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                       Azure Resource Group                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Web (ACA)  │  │   API (ACA)  │  │      ACR         │   │
│  │  Next.js     │  │  NestJS      │  │  Docker Images   │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│         │                  │                                 │
│  ┌──────┴──────────────────┴──────┐  ┌──────────────────┐   │
│  │  Container Apps Environment    │  │  Log Analytics   │   │
│  └────────────────────────────────┘  └──────────────────┘   │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ PostgreSQL Flex  │  │  Azure Redis     │                 │
│  └──────────────────┘  └──────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites
- Azure subscription
- Azure CLI installed (`az`)
- GitHub repository with Actions enabled
- Docker installed (for local image testing)

## 1. Initial Azure Setup

### Login & create Service Principal for GitHub Actions
```bash
az login

# Create service principal with Contributor role on subscription
az ad sp create-for-rbac \
  --name "voiceforge-github-actions" \
  --role contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID> \
  --json-auth
```
Save the JSON output as `AZURE_CREDENTIALS` in GitHub Secrets.

### Create resource groups
```bash
az group create --name voiceforge-staging-rg --location eastus
az group create --name voiceforge-production-rg --location eastus
```

## 2. Azure DevOps Variable Groups

Create the following variable groups in **Azure DevOps → Pipelines → Library**.

### `voiceforge-common` (shared across environments)
| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | e.g. `https://vocal.devdeepak.me/api/v1` |
| `NEXT_PUBLIC_APP_URL` | e.g. `https://vocal.devdeepak.me` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | From Clerk Dashboard |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` | `/dashboard` |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` | `/dashboard` |
| `AZURE_ACR_LOGIN_SERVER` | e.g. `vf1234abcd.azurecr.io` |
| `AZURE_ACR_USERNAME` | ACR admin username |

### `voiceforge-staging-secrets`
| Secret | Description |
|--------|-------------|
| `AZURE_ACR_PASSWORD` | ACR admin password |
| `DATABASE_URL` | PostgreSQL pooled connection string |
| `DIRECT_URL` | PostgreSQL direct connection string |
| `REDIS_URL` | Redis connection string (optional) |
| `CLERK_SECRET_KEY` | From Clerk Dashboard |
| `OPENAI_API_KEY` | OpenAI API key |

### `voiceforge-prod-secrets`
Same keys as staging, but pointing to production resources.

> **Note:** `NEXT_PUBLIC_*` variables are **build-time only** for Next.js standalone output. They must be set in the pipeline before the Docker image is built.

## 3. Deployment Workflow (`azure-pipelines.yml`)

Trigger: Push to `main` or `staging`, or PR.

### Stage 1 — Build & Quality Gate
1. Install Node.js 20
2. Cache + `npm ci`
3. Typecheck, lint, test (shared + API)

### Stage 2 — Build & Push to ACR
1. Login to ACR (`docker login`)
2. Cache Docker layers
3. Build & push API image → `$(AZURE_ACR_LOGIN_SERVER)/voiceforge-api:<sha|branch|latest>`
4. Build & push Web image → `$(AZURE_ACR_LOGIN_SERVER)/voiceforge-web:<sha|branch|latest>`

### Stage 3 — Deploy to Azure VM (Staging / Production)
1. SSH into the target VM
2. `docker login` to ACR
3. Export `WEB_IMAGE` / `API_IMAGE` to point to ACR
4. `docker compose -f docker-compose.prod.yml pull && up -d`
5. Health checks on `:4000/health` and `:3000/api/health`
Steps:
1. Login to Azure
2. Deploy `infra/bicep/main.bicep` with current `github.sha` image tags
3. Smoke test (`/health` on API and Web)

## 4. Bicep Infrastructure

All infrastructure is defined in `infra/bicep/`:

| File | Purpose |
|------|---------|
| `main.bicep` | Orchestrates all modules |
| `modules/acr.bicep` | Azure Container Registry |
| `modules/containerAppsEnvironment.bicep` | ACA environment + Log Analytics |
| `modules/containerApp.bicep` | Reusable ACA app (Web or API) |
| `modules/postgres.bicep` | PostgreSQL Flexible Server |
| `modules/redis.bicep` | Azure Cache for Redis |
| `modules/logAnalytics.bicep` | Monitoring workspace |

### Manual Bicep Deployment
```bash
# Bash
export DATABASE_URL="postgresql://..."
export DIRECT_URL="postgresql://..."
# ... set all required env vars
./infra/scripts/deploy.sh staging voiceforge-staging-rg eastus

# PowerShell
$env:DATABASE_URL = "postgresql://..."
# ... set all required env vars
.\infra\scripts\deploy.ps1 -Environment staging
```

## 5. Post-Deployment

### Database Migrations
After the first infrastructure deploy, run Prisma migrations against the PostgreSQL server:
```bash
# Update DATABASE_URL and DIRECT_URL to point to Azure PostgreSQL
npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma
```
> Consider running migrations via a GitHub Actions job or Azure Container Job.

### Configure Custom Domain (Optional)
1. Add custom domain to ACA Web app:
   ```bash
   az containerapp hostname bind \
     --hostname app.voiceforge.ai \
     --resource-group voiceforge-production-rg \
     --name vf-web-production
   ```
2. Update DNS with the verification TXT record.
3. Update GitHub Variables `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_APP_URL`.
4. Re-run CI to rebuild images with new public URLs.

### Scaling
Edit `containerCpu`, `containerMemory`, `minReplicas`, `maxReplicas` in Bicep or via Azure Portal.
Production defaults in Bicep:
- CPU: `1.0`
- Memory: `2.0Gi`
- Max replicas: `5`

## 6. Security Checklist
- [ ] ACR admin user disabled after CI/CD is switched to managed identity
- [ ] PostgreSQL firewall restricted (remove `AllowAllAzureServices` rule, use VNet integration)
- [ ] Redis non-SSL port disabled (enabled in template)
- [ ] Secrets rotated every 90 days
- [ ] Container Apps use HTTPS only (enforced by ACA ingress)
- [ ] API health endpoint (`/health`) exposed and probed
- [ ] Webhook secrets (Vapi, Clerk) validated in app code

## 7. Troubleshooting

### Images fail to pull
- Verify ACR password is passed to Container App module (`acrAdminUserEnabled=true`)
- Check GitHub Secrets `AZURE_ACR_USERNAME` / `AZURE_ACR_PASSWORD`

### Database connection refused
- Ensure `AllowAllAzureServices` firewall rule exists (first deploy)
- Use `DATABASE_URL` with `pgbouncer=true` for pooled connections
- Use `DIRECT_URL` (port 5432) for Prisma migrations only

### NEXT_PUBLIC_* env vars not working
- These are **build-time only** in Next.js standalone output
- Update GitHub Variables → re-run CI → new image tag → re-run CD

## 8. Cost Optimization (Staging)
The Bicep defaults for `staging` use:
- PostgreSQL: `Burstable` tier (`Standard_B1ms`) ~ $12/mo
- Redis: `Basic` tier (`C0`) ~ $16/mo
- Container Apps: scale to zero (`minReplicas: 0`) ~ pay per request
- ACR: `Standard` SKU ~ $5/mo

Total estimated staging cost: **$30–50/month**.
