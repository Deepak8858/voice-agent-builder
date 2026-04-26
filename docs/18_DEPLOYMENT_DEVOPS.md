# 18 — Deployment and DevOps

## Environments
local, development, staging, production.

## MVP Deployment
```txt
Frontend: Vercel
Backend: Railway/Render/Fly.io or AWS ECS
Database: Neon/Supabase Postgres
Redis: Upstash
Storage: Cloudflare R2
Analytics: PostgreSQL first, ClickHouse Cloud later
Voice: Vapi/Retell
Billing: Stripe
```

## Azure DevOps (Container Apps)
An alternative, fully-Azure deployment path is documented in `docs/31_AZURE_DEVOPS.md`.
```txt
Frontend: Azure Container Apps (Next.js standalone)
Backend: Azure Container Apps (NestJS)
Database: Azure Database for PostgreSQL — Flexible Server
Redis: Azure Cache for Redis
Registry: Azure Container Registry (ACR)
CI/CD: GitHub Actions → ACR → Bicep → ACA
IaC: Bicep (infra/bicep/)
```

## Production Deployment
```txt
Frontend: Vercel/Cloudflare Pages
Backend: AWS ECS/Fargate or Kubernetes
Database: RDS PostgreSQL
Redis: ElastiCache
Storage: S3
Workflows: Temporal Cloud
Analytics: ClickHouse Cloud
Observability: OpenTelemetry + Sentry + Grafana/HyperDX
```

## CI/CD
`Install → Typecheck → Lint → Test → Build → Migration check → Deploy staging → Smoke test → Deploy production`

## Production Launch Checklist
Auth configured, Stripe configured, voice provider keys set, webhook signatures enabled, backups enabled, error monitoring enabled, rate limits enabled, compliance gate enabled, outbound restricted by default.
