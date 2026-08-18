# VoiceForge AI — Operations Runbook

**Version:** 2.0  
**Last Updated:** 2026-08-09  
**Environment:** AWS EC2 (single `t3.large`, `us-east-1`, account `543777713748`) + external Supabase Postgres + Redis in-stack

Production is one EC2 instance running the Compose stack in
`infra/docker/docker-compose.aws.yml`: `vf-nginx`, `vf-web`, `vf-api`,
`vf-api-worker`, `vf-redis`, and optionally `vf-livekit-agent`. Only nginx
publishes host ports (80/443); the application containers are reachable solely
on the internal `voiceforge` bridge network. Postgres is external Supabase and is
not part of this stack.

---

## 1. On-Call Playbook

### P0 — API completely down
1. SSH to the host: `ssh <deploy-user>@incfrog.ai`
2. Check containers: `docker compose --env-file /opt/voiceforge/.env -f /opt/voiceforge/docker-compose.aws.yml ps`
   → `vf-api`, `vf-web`, `vf-api-worker`, `vf-redis`, `vf-nginx` should be `Up`
3. Check logs: `docker logs --tail 200 vf-api`
4. Probe the API from inside its own container (there is no host port):
   ```bash
   docker exec vf-api node -e "require('http').get('http://127.0.0.1:4000/api/v1/health',r=>{r.pipe(process.stdout)})"
   ```
5. If a container crashed, recreate only that service — never rebuild on the host:
   ```bash
   cd /opt/voiceforge
   ECR_REGISTRY=543777713748.dkr.ecr.us-east-1.amazonaws.com \
   IMAGE_TAG="$(cat deploy-state/current-sha)" \
   WEB_IMAGE_TAG="$(cat deploy-state/current-web-tag 2>/dev/null || cat deploy-state/current-sha)" \
   docker compose --env-file .env -f docker-compose.aws.yml up -d --no-build api
   ```
   `WEB_IMAGE_TAG` is required by the compose file even when recreating only
   `api`; the web image carries a configuration digest suffix recorded in
   `deploy-state/current-web-tag`.
6. If Postgres is unreachable, verify Supabase status first; the API cannot heal a
   database outage on its own.

### P1 — Degraded performance (slow responses)
1. Check host pressure: `top -bn1 | head -20`, `free -m`, `df -h`
2. Check per-container usage: `docker stats --no-stream`
3. Inspect DB slow queries via Supabase Dashboard → Reports → Query Performance
4. Check Redis memory: `docker exec vf-redis redis-cli INFO memory`
   (`maxmemory` is 384 MB with `noeviction` — a full Redis fails writes rather
   than silently dropping queued jobs)
5. Run a load baseline from a workstation, not from the host:
   `k6 run k6/baseline.js -e BASE_URL=https://incfrog.ai/api/v1`
6. `t3.large` is a burstable instance. Sustained high CPU drains CPU credits and
   degrades gradually; check CloudWatch `CPUCreditBalance` before concluding the
   application is at fault.

### P2 — Security incident
1. Rotate `SUPABASE_JWT_SECRET`, `JWT_SECRET`, `ENCRYPTION_KEY`, and
   `INTERNAL_API_KEY` in `/opt/voiceforge/.env`, then redeploy the current SHA
2. Revoke active sessions via Supabase Dashboard → Authentication → Sessions
3. Check `audit_logs` for suspicious `action` patterns in the last 1h
4. If the metrics endpoint was exposed, rotate `METRICS_SCRAPE_TOKEN`
5. Preserve logs before anything is recreated:
   `docker logs vf-api > /tmp/vf-incident-$(date +%s).log`
6. To cut off ingress without destroying evidence, tighten the security group
   rather than stopping containers.

---

## 2. Deployment Procedures

Production is deployed **only** through the **Deploy production to AWS EC2**
workflow (`.github/workflows/deploy-aws-ec2.yml`). It is `workflow_dispatch`-only
and takes:
- `git_sha` — the full 40-character commit SHA to build and deploy
- `confirm_production` — the literal string `deploy-production`

Do not deploy by hand. Images are built by Depot, pushed to ECR tagged with the
exact commit SHA, and pulled on the host; nothing is ever built on EC2.

The workflow validates repository configuration, builds the three images (skipping
any tag already published, because the ECR repositories are immutable), uploads the
compose file plus all five nginx artifacts and the two systemd units, runs
`prisma migrate status` followed by `migrate deploy` while the previous release is
still serving, replaces the services, and only then records the release as current.

### Health verification
`api` and `web` publish no host ports, so the workflow probes health **inside the
containers** with `docker compose exec -T <service> node -e ...` against
`http://127.0.0.1:4000/api/v1/health` and `http://127.0.0.1:3000/api/health`.
It then checks the two public URLs through nginx. Reproduce the internal probe
manually with the `docker exec` command in §1. Do not "fix" a failing check by
publishing host ports for `api` or `web`; keeping them off the host is deliberate.

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

**2. Populate `/opt/voiceforge/.env`.** The workflow reads it on the host and
fails before touching the running stack if a required variable is missing or
invalid. It enforces `NODE_ENV=production`, `BILLING_MODE=live`, an `https://`
non-localhost `WEB_BASE_URL`, a numeric `TRUST_PROXY_HOPS`, and — when
`KNOWLEDGE_STORAGE_PROVIDER=s3` — a non-empty `S3_KNOWLEDGE_BUCKET` with
`AWS_REGION=us-east-1`. LiveKit must be configured with all three of
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, or none; a partial set
aborts the deploy. See `.env.production.example`.

**3. TLS bootstraps itself, in two states.** nginx serves HTTP only until a
certificate exists, so the first deploy to a fresh host succeeds without one.
The entrypoint hook enables the port-443 server and HTTP→HTTPS redirects as soon
as `/opt/voiceforge/data/certbot/conf/live/incfrog.ai/` holds a full key pair.
Issue the first certificate with the procedure in `infra/nginx/TLS-BOOTSTRAP.txt`,
then recreate nginx. Renewal runs from the `voiceforge-certbot-renew.timer`
systemd unit, which the deploy installs and enables; verify with
`systemctl list-timers voiceforge-certbot-renew.timer`. There is no `TLS_MODE`
variable any more.

**4. Do not pre-create a stack by hand.** If no release has been recorded yet but
`vf-api`, `vf-web`, or `vf-nginx` are already running, the workflow refuses to
replace containers it cannot roll back.

### Database Migration
Migrations run automatically as part of the deploy, before service replacement.
They are **forward-only and are never rolled back**, so every migration must be
backward-compatible with the previous release (expand/contract). A migration that
drops or renames a column makes automatic image rollback unsafe — land the
destructive half in a later release, after the new code is stable.
```bash
# Manual invocation (rare — prefer the workflow)
docker compose --env-file /opt/voiceforge/.env -f /opt/voiceforge/docker-compose.aws.yml \
  run --rm --no-deps api npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma
# NEVER use db:push in production
```

### Rollback
Rollback is automatic: if health checks fail after replacement, the workflow
restores the previous release **bundle** (compose file, all five nginx files, and
both systemd units, together with the image tags) and re-verifies health inside
the containers before recording it as current. Restoring images alone would leave
the failed release's deployment definition active.

To roll back deliberately, re-run the workflow with the previous SHA, which you
can read from the host:
```bash
cat /opt/voiceforge/deploy-state/current-sha
cat /opt/voiceforge/deploy-state/previous-sha
ls /opt/voiceforge/deploy-state/releases/
```
If a rollback itself fails its health check the workflow says so explicitly and
stops; production then needs manual intervention and the recorded current release
is deliberately left unchanged.

**Retention limit — rollback is not unbounded.** The ECR repositories keep only
the **10 newest images** per repository under a lifecycle policy, and the host
prunes every local image and release bundle except the current and previous SHA.
Rolling back to the immediately previous release is instant. Anything older is a
**rebuild-from-SHA**: re-dispatch the workflow with that older commit, which will
build and push the images again (the immutable-tag guard skips the push only if
the tag still exists). Budget build time accordingly — this is not a fast path,
and it requires the commit to still build from source.

---

## 3. Backup & Restore

### Automated Backups
- Supabase provides **daily PITR backups** (Point-in-Time Recovery) via the dashboard.
- The EC2 root volume is a 30 GB encrypted gp3 disk. **Provisioning creates no
  snapshot or lifecycle policy** — the host is treated as disposable. The only
  state on it is `/opt/voiceforge/.env`, `deploy-state/`, the certbot directories,
  and the `voiceforge_redis_data` volume. Keep `.env` in a password manager;
  everything else is reproducible from a deploy.

### Manual Backup Verification
```bash
node scripts/backup-validation.js --verbose
```

### Restore from Supabase
1. Go to Supabase Dashboard → Database → Backups
2. Select timestamp → Restore
3. Restart the API to clear the Prisma connection pool: `docker restart vf-api`

---

## 4. Health Checks

| Endpoint | Expected | Check |
|----------|----------|-------|
| `GET /api/v1/health` (public) | 200 `{ status, db, redis }` | `curl -f https://incfrog.ai/api/v1/health` |
| `GET /api/health` (public, web) | 200 | `curl -f https://incfrog.ai/api/health` |
| nginx liveness (host-local) | 200 | `curl -f http://127.0.0.1/nginx-health` |
| API metrics (unauthenticated) | 401 | `curl -s -o /dev/null -w "%{http_code}" https://incfrog.ai/api/v1/metrics` |
| API metrics (with token) | 200 | `curl -f -H "Authorization: Bearer $METRICS_SCRAPE_TOKEN" https://incfrog.ai/api/v1/metrics` |

Every service also carries a Compose healthcheck; `docker compose ps` reports the
aggregate state, and `vf-api-worker` is verified as running rather than by HTTP
because it serves no traffic.

### k6 Load Tests
```bash
# Smoke (CI gate)
k6 run k6/smoke.js -e BASE_URL=https://incfrog.ai/api/v1

# Baseline (2min steady-state)
k6 run k6/baseline.js -e BASE_URL=https://incfrog.ai/api/v1

# Stress (find breaking point)
k6 run k6/stress.js -e BASE_URL=https://incfrog.ai/api/v1
```

---

## 5. Observability

There is **no Prometheus and no Grafana** in the AWS stack; they were removed
deliberately, not lost in the migration.

- **Product and funnel analytics:** PostHog.
- **Container logs:** the `json-file` driver, capped per service at 10 MB × 3
  files in `docker-compose.aws.yml`. Read them with `docker logs`; there is no
  log shipper, so capture anything you need before recreating a container.
- **Host and instance metrics:** CloudWatch (CPU, credits, network, disk).
  Watch `CPUCreditBalance` on this burstable instance type.
- **Cost:** an AWS Budget created by `infra/aws/provision.sh` emails at 80% of
  the forecasted monthly limit.
- **Application metrics:** `GET /api/v1/metrics` still exists and is protected by
  `METRICS_SCRAPE_TOKEN`. Nothing scrapes it by default.

Alerting is therefore CloudWatch alarms plus PostHog, not Prometheus alert rules.

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
# Compose shorthand on the host
alias vfc='docker compose --env-file /opt/voiceforge/.env -f /opt/voiceforge/docker-compose.aws.yml'

# Stream API logs live
docker logs -f vf-api --tail 100

# Enter API container shell
docker exec -it vf-api sh

# Redis CLI
docker exec -it vf-redis redis-cli

# Which commit is live
cat /opt/voiceforge/deploy-state/current-sha

# Reload nginx after a certificate change
docker kill --signal=HUP vf-nginx

# Certificate expiry and renewal timer
docker run --rm -v /opt/voiceforge/data/certbot/conf:/etc/letsencrypt \
  certbot/certbot:v3.2.0 certificates
systemctl list-timers voiceforge-certbot-renew.timer
```
