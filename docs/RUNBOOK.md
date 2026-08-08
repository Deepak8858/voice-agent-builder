# VoiceForge AI — Operations Runbook

**Version:** 1.0  
**Last Updated:** 2026-05-01  
**Environment:** Azure VM (`voiceforge-staging-vm`) + Supabase Postgres + AWS ElastiCache Valkey

---

## 1. On-Call Playbook

### P0 — API completely down
1. Check VM health: `az vm show -g voiceforge-rg -n voiceforge-staging-vm --query instanceView.statuses`
2. SSH into VM: `ssh devops@vocal.devdeepak.me`
3. Check containers: `docker ps` → verify `vf-api`, `vf-web`, `vf-redis` are `Up`
4. Check logs: `docker logs --tail 200 vf-api`
5. If API container crashed: `docker compose -f docker-compose.prod.yml up -d vf-api`
6. If DB unreachable: run `apps/api/scripts/supabase-probe.ts` from the VM

### P1 — Degraded performance (slow responses)
1. Check k6 baseline: `k6 run k6/baseline.js -e BASE_URL=https://vocal.devdeepak.me/api/v1`
2. Inspect DB slow queries via Supabase Dashboard → Reports → Query Performance
3. Check Redis memory: `docker exec vf-redis redis-cli INFO memory`
4. Scale VM if CPU > 80% sustained: `az vm resize -g voiceforge-rg -n voiceforge-staging-vm --size Standard_D4s_v3`

### P2 — Security incident
1. Rotate `SUPABASE_JWT_SECRET` and `JWT_SECRET` immediately
2. Revoke active sessions via Supabase Dashboard → Authentication → Sessions
3. Check `audit_logs` for suspicious `action` patterns in last 1h
4. If metric endpoint exposed, rotate `METRICS_SCRAPE_TOKEN`
5. Preserve logs: `docker logs vf-api > /var/log/vf/incident-$(date +%s).log`

---

## 2. Deployment Procedures

Production is deployed **only** through the `deploy-azure-vm.yml` GitHub Actions
workflow. Do not deploy by hand: a manual `git pull` on the VM produces a
release that cannot be traced to a commit and has no rollback bundle.

### Standard Deploy
Run the **Deploy to Azure VM** workflow with:
- `git_sha` — the full 40-character commit SHA to deploy
- `confirm_production` — the literal string `deploy-production`

The workflow builds images on the VM tagged with the SHA, runs migrations while
the previous release is still serving, replaces the services, and then verifies
both local and public health before recording the release as current.

### Deploy prerequisites (one time)

**1. Baseline the database.** The workflow runs `prisma migrate status` before
`migrate deploy` and refuses to continue if it fails. The baseline migration uses
unconditional `CREATE TABLE`, so a production database that was never recorded in
`_prisma_migrations` will otherwise fail mid-deploy trying to recreate existing
tables. Compare the live schema against the migration history first, and only
then mark the baseline as applied:
```bash
npx prisma migrate status --schema=apps/api/prisma/schema.prisma
# Only after confirming the live schema matches the baseline:
npx prisma migrate resolve --applied 20260401000000_init --schema=apps/api/prisma/schema.prisma
```
Do not run `migrate resolve` speculatively — marking a migration applied without
verifying schema equivalence hides real drift.

**2. Confirm `TLS_MODE`.** `/opt/voiceforge/.env` selects which nginx config is
installed. It defaults to `https`, which installs `infra/nginx/nginx.azure-https.conf`
(ports 80 + 443, certificates from `/opt/voiceforge/data/certs`). Set
`TLS_MODE=http` **only** for a VM that has no certificates yet; on a domain that
already serves HTTPS this would take TLS down.

**3. Let the first run adopt the existing stack.** If no release has been
recorded yet, the workflow retags the running API/web images as `:adopted` and
archives the live compose + nginx files as a rollback bundle. This requires
`/opt/voiceforge/docker-compose.azure.yml` and `/opt/voiceforge/nginx/nginx.conf`
to exist; the workflow fails fast if they do not.

### Database Migration
Migrations run automatically as part of the deploy, before service replacement.
They are **forward-only and are never rolled back**, so every migration must be
backward-compatible with the previous release (expand/contract). A migration that
drops or renames a column makes automatic image rollback unsafe — land the
destructive half in a later release, after the new code is stable.
```bash
# Manual invocation (rare — prefer the workflow)
cd /opt/voiceforge/apps/api
npx prisma migrate deploy
# NEVER use db:push in production
```

### Rollback
Rollback is automatic: if health checks fail after replacement, the workflow
restores the previous release **bundle** (compose file, nginx config, and image
tags together) and re-verifies health before recording it as current. Restoring
images alone would leave the failed release's deployment definition active.

To roll back deliberately, re-run the workflow with the previous SHA, which you
can read from the VM:
```bash
cat /opt/voiceforge/deploy-state/current-sha
cat /opt/voiceforge/deploy-state/previous-sha
ls /opt/voiceforge/deploy-state/releases/
```
If a rollback itself fails its health check the workflow says so explicitly and
stops; production then needs manual intervention and the recorded current release
is deliberately left unchanged.

---

## 3. Backup & Restore

### Automated Backups
- Supabase provides **daily PITR backups** (Point-in-Time Recovery) via the dashboard.
- VM disk snapshots via Azure Backup (nightly).

### Manual Backup Verification
```bash
node scripts/backup-validation.js --verbose
```

### Restore from Supabase
1. Go to Supabase Dashboard → Database → Backups
2. Select timestamp → Restore
3. Restart API container to clear Prisma connection pool: `docker restart vf-api`

---

## 4. Health Checks

| Endpoint | Expected | Check |
|----------|----------|-------|
| `GET /api/v1/health` | 200 `{ status, db, redis }` | `curl -f https://vocal.devdeepak.me/api/v1/health` |
| `GET /api/health` | 200 | `curl -f https://vocal.devdeepak.me/api/health` |
| Prometheus metrics | 401 without token | `curl -f -H "Authorization: Bearer $TOKEN" https://vocal.devdeepak.me/api/v1/metrics` |

### k6 Load Tests
```bash
# Smoke (CI gate)
k6 run k6/smoke.js -e BASE_URL=https://vocal.devdeepak.me/api/v1

# Baseline (2min steady-state)
k6 run k6/baseline.js -e BASE_URL=https://vocal.devdeepak.me/api/v1

# Stress (find breaking point)
k6 run k6/stress.js -e BASE_URL=https://vocal.devdeepak.me/api/v1
```

---

## 5. Alerting Rules (Prometheus-style)

```yaml
# api-availability
- alert: APIHighErrorRate
  expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
  for: 2m
  labels: { severity: critical }

# db-latency
- alert: DBSlowQueries
  expr: avg(http_request_duration_seconds{route=~"/workspaces/.+/agents"}) > 1.0
  for: 5m
  labels: { severity: warning }

# redis-down
- alert: RedisDisconnected
  expr: up{job="voiceforge-api", redis="error"} == 1
  for: 1m
  labels: { severity: critical }
```

---

## 6. Escalation Matrix

| Severity | Responder | SLA | Escalate To |
|----------|-----------|-----|-------------|
| P0 — Outage | On-call engineer | 15 min | Engineering Lead |
| P1 — Degraded | On-call engineer | 1h | Engineering Lead |
| P2 — Security | Security lead + On-call | 30 min | CTO |
| P3 — Feature bug | Next business day | 24h | Product |

---

## 7. Useful Commands

```bash
# Stream API logs live
docker logs -f vf-api --tail 100

# Enter API container shell
docker exec -it vf-api sh

# Redis CLI
docker exec -it vf-redis redis-cli

# Prisma introspect (read-only)
npx prisma db pull

# Force-clear cache
node -e "require('./apps/api/dist/cache/cache.service').CacheService.prototype.del('key')"
```
