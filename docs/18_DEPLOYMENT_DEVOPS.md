# 18 — Deployment and DevOps

## Environments
local, development, staging, production.

## Current Production Deployment
```txt
Compute: single AWS EC2 t3.large in us-east-1
Frontend/API/workers: Docker Compose on EC2 behind nginx and CloudFront
Database: external Supabase Postgres
Redis: containerized Redis in the EC2 Compose stack
Knowledge storage: private, versioned Amazon S3
Images: Depot builds → immutable SHA-tagged Amazon ECR repositories
Voice: OpenAI Realtime + in-house Azure pipeline (LiveKit transport)
Billing: Stripe
```

`infra/docker/docker-compose.aws.yml` is the production stack. Provisioning assets
and the current AWS foundation runbook live under `infra/aws/`; the superseded Azure
Container Apps design in `docs/31_AZURE_DEVOPS.md` is not an active deploy path.

## CI/CD
`.github/workflows/quality-gate.yml` runs automatically on pull requests and pushes
to `main`: frozen install → secret scan and dependency audit → Prisma/shared setup →
typecheck → lint → test → builds and image dependency checks. Branch protection is
not yet configured, so these jobs are not currently enforced as required checks.

Production deploys are separate and operator-initiated. Dispatch
`.github/workflows/deploy-aws-ec2.yml` with a full 40-character commit SHA and
`confirm_production=deploy-production`. It builds with Depot, pushes to ECR, runs
migration checks, deploys to EC2, verifies internal and public health, records the
release, and automatically restores the previous release bundle on failure. See
`docs/RUNBOOK.md` for the operational procedure.

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
3. Run `pnpm db:verify` and verify schema integrity; never use `db:push` against production.
4. Run `k6 run k6/smoke.js` against staging to confirm health endpoints pass.

## Load Test Thresholds

Use the scripts in `k6/` to validate performance before each production deploy.
Run them against **staging** (never production).

| Script | Duration | VUs | Pass threshold | Fail threshold |
|--------|----------|-----|----------------|----------------|
| `smoke.js` | 30s | 1 | p95 < 1s, errors < 0.1% | - |
| `baseline.js` | 2m | 10 | p95 < 500ms, errors < 1% | p95 > 1s, errors > 5% |
| `stress.js` | 2.5m | ramp to 50 | p99 < 2s, errors < 5% | p99 > 5s, errors > 10% |

### Deployment integration
The AWS deploy workflow performs API and web health checks both inside the
containers and through the public nginx endpoints. The k6 suites remain manual
staging checks; integrating them into deployment is still open and requires a
staging target rather than running load against production.

### Baseline expectations for production sizing
- **10 VUs × 0.5 req/s per VU ≈ 5 req/s** sustained = ~432K requests/day.
- If baseline p95 exceeds 500ms at 10 VUs, add a PostgreSQL connection pooler (PgBouncer) before scaling horizontally.
- Stress test identifies the **max sustainable throughput** — target 3× your expected peak.
