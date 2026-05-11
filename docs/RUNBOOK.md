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

### Standard Deploy
```bash
# On the VM
cd /opt/voiceforge
git pull origin main
docker compose -f docker-compose.prod.yml build vf-api vf-web
docker compose -f docker-compose.prod.yml up -d
```

### Database Migration
```bash
cd /opt/voiceforge/apps/api
npx prisma migrate deploy
# NEVER use db:push in production
```

### Rollback
```bash
cd /opt/voiceforge
git reset --hard HEAD~1
docker compose -f docker-compose.prod.yml up -d --build
```

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
