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

## Backup Strategy

### Database (Neon / Supabase / Azure PostgreSQL)
- **Daily automated backups** retained for 30 days (Neon/Branch/Supabase default).
- **Point-in-time recovery (PITR)** for the last 7 days on Neon.
- **Before major migrations** manually trigger a branch/backup snapshot.
- Test restore procedure at least once per quarter.

### Redis / Valkey (Upstash / ElastiCache)
- Upstash: built-in replication + point-in-time restore via console.
- ElastiCache: enable automatic backups (snapshot retention 1–35 days).
- Key expiry handles most cache invalidation; no need to back up volatile data.

### Application State
- **BullMQ job queues**: jobs are persisted to Redis/Valkey — lost workers are replaced by new pods reading the same queue.
- **S3/R2 media**: versioning enabled on the bucket; lifecycle policy moves old objects to IA after 90 days.
- **Secrets**: stored in environment variables / AWS Secrets Manager / Railway env vars — never in the repo.

### Backup Verification
Run a quarterly restore test in a staging environment:
1. Snapshot the production DB.
2. Restore to a staging instance.
3. Run `npm run db:push -- --accept-data-loss` and verify schema integrity.
4. Run `k6 run k6/smoke.js` against staging to confirm health endpoints pass.

## Load Test Thresholds

Use the scripts in `k6/` to validate performance before each production deploy.
Run them against **staging** (never production).

| Script | Duration | VUs | Pass threshold | Fail threshold |
|--------|----------|-----|----------------|----------------|
| `smoke.js` | 30s | 1 | p95 < 1s, errors < 0.1% | - |
| `baseline.js` | 2m | 10 | p95 < 500ms, errors < 1% | p95 > 1s, errors > 5% |
| `stress.js` | 2.5m | ramp to 50 | p99 < 2s, errors < 5% | p99 > 5s, errors > 10% |

### CI Integration
Add smoke tests to the deployment pipeline so failing thresholds block the deploy:

```yaml
# .github/workflows/deploy.yml (GitHub Actions)
- name: Run smoke tests
  run: |
    npm install -g k6
    k6 run k6/smoke.js -e BASE_URL=${{ env.STAGING_API_URL }}
```

### Baseline expectations for production sizing
- **10 VUs × 0.5 req/s per VU ≈ 5 req/s** sustained = ~432K requests/day.
- If baseline p95 exceeds 500ms at 10 VUs, add a PostgreSQL connection pooler (PgBouncer) before scaling horizontally.
- Stress test identifies the **max sustainable throughput** — target 3× your expected peak.
