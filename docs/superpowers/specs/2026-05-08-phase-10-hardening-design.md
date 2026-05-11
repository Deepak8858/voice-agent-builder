# Phase 10 Production Hardening — Design Spec

## Context

VoiceForge AI phases 0-9 fully implemented and deployed to **AWS EC2** via Docker Compose (SSH: `ubuntu@13.234.56.188`, key: `ssh/voiceforge-ec2.pem`). Phase 10 (production hardening) is partially done.

## What's Already Done

- Auth: Supabase JWT verification (Clerk replaced)
- RateLimitGuard written but not globally applied
- Voice webhook HMAC verification present
- Metrics endpoint with bearer-token protection
- Billing URL validation (`isTrustedRedirectUrl`)
- Helmet security headers, CORS with production guard
- OTel tracing auto-instrumented (HTTP, Express, Prisma)
- GitHub Actions CI/CD to Azure VM
- Dockerfile + docker-compose.prod.yml

## What's NOT Done

### Security (from SECURITY_AUDIT.md + WEB_SECURITY_AUDIT.md)

| # | Issue | Severity | File |
|---|-------|----------|------|
| S1 | RateLimitGuard never globally applied | HIGH | `app.module.ts` |
| S2 | Billing controller mass assignment (ZodValidationPipe missing on createPortal) | HIGH | `billing.controller.ts` |
| S3 | White-label logo_url not validated as https | MEDIUM | `white-label.service.ts` |
| S4 | Client invite email not verified on accept | HIGH | `white-label.service.ts` |
| S5 | Agent flow update unvalidated (nodes/edges no Zod schema enforced) | MEDIUM | `agents.controller.ts` |
| S6 | CSP headers missing from next.config.ts | HIGH | `next.config.ts` |
| S7 | No `X-Requested-With` CSRF header on API calls | LOW | `lib/api.ts`, `lib/use-api.ts` |

### Observability — Prometheus + Grafana

Current state:
- `/api/v1/metrics` endpoint exists (Prometheus format, bearer-token protected)
- OTel auto-instruments HTTP + Prisma
- No Prometheus server deployed
- No Grafana deployed
- No alerting rules
- No pre-built dashboards

### Load Testing

- No load testing tooling
- No baseline performance metrics
- Need to stress-test: agent generation, knowledge retrieval, call event ingestion

### Database Backups

- Supabase handles base backups (daily)
- No point-in-time recovery configured
- No backup schedule documentation
- No backup restore tested

### Edge Case Testing

- Unit tests cover happy paths
- Missing: auth edge cases, workspace isolation, webhook signature forgery, concurrent writes, large file uploads

---

## Design

### 1. Security Fixes

**S1 — Apply RateLimitGuard globally**

Apply `RateLimitGuard` via `APP_MODULE.providers` using a NestJS middleware approach. Rate limits:
- Auth endpoints (signup/login): 5 req/min per IP
- API general: 100 req/min per workspace (already configured)
- Webhooks: skip via `@SkipRateLimit()` (already decorated)

Implementation: Use NestJS `APP_GUARD` token to register as global guard. Exclude health/metrics/webhooks at guard level.

**S2 — Billing mass assignment fix**

`createPortal` endpoint missing `ZodValidationPipe`. Add it.

**S3 — White-label logo_url validation**

In `WhiteLabelSettingsDtoSchema` (shared package): `logoUrl` must be `z.string().url().startsWith('https://')`.

**S4 — Client invite email verification**

In `white-label.service.ts`: `acceptInvite` must check `user.email === invite.email`. Also add `WorkspaceGuard` to invite acceptance endpoint.

**S5 — Agent flow validation**

Add Zod schema to `UpdateFlowDtoSchema` in agents controller:
```typescript
const FlowNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['start', 'speak', 'ask-question', 'condition', 'tool-call', 'transfer', 'end']),
  data: z.record(z.unknown()),
});
const UpdateFlowDtoSchema = z.object({
  nodes: z.array(FlowNodeSchema),
  edges: z.array(z.object({ id: z.string(), source: z.string(), target: z.string() })),
});
```
Apply `ZodValidationPipe` to `@Body()` on `updateFlow` endpoint.

**S6 — CSP headers**

Add security headers to `next.config.ts`:
```typescript
headers: [{
  source: '/(.*)',
  headers: [
    { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline';" },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ],
}]
```
Note: `'unsafe-eval'` needed for Next.js RSC + SWC. `strict-dynamic` can be added once SWC supports it.

**S7 — CSRF header**

Add `X-Requested-With: XMLHttpRequest` to all API calls in `lib/api.ts` and `lib/use-api.ts`.

---

### 2. Observability Stack — Prometheus + Grafana

**Architecture:**
```
API pod (NestJS)  →  Prometheus  →  Grafana
                        ↑
                   Azure VM metrics
```

Since app runs as Docker Compose on AWS EC2, deploy Prometheus + Grafana as additional Docker Compose services alongside api/web.

**Deployment target:** AWS EC2, Docker Compose v2 (Docker Swarm). Current stack: web (Next.js), api (NestJS), redis, nginx.

SSH: `ssh -i ssh/voiceforge-ec2.pem ubuntu@13.234.56.188`

App location: `/opt/voiceforge/` (per docker-compose.prod.yml)

**Docker Compose additions:**
- `prometheus` — scrapes `/api/v1/metrics` every 15s
- `grafana` — Dashboards on port 3001 (reverse-proxied via nginx)
- `alertmanager` — Alert routing (defer to Phase 11)

**Files to create:**
- `monitoring/prometheus/prometheus.yml` — scrape config
- `monitoring/grafana/provisioning/dashboards/dashboards.yml` — auto-provision
- `monitoring/grafana/provisioning/datasources/datasources.yml` — prometheus datasource
- `monitoring/grafana/provisioning/dashboards/voiceforge.json` — pre-built dashboard
- `docker-compose.monitoring.yml` — stacks with main compose
- `nginx/nginx.conf` — add route for `/grafana`

**Grafana Dashboard Panels (pre-built):**
1. **API Overview** — Request rate, latency p50/p95/p99, error rate
2. **Auth Metrics** — Signup/login attempts, JWT validation failures, session cache hit rate
3. **Agent Builder** — Agent creation/generation count, generation latency, LLM cache hit rate
4. **Knowledge Retrieval** — Embedding requests, retrieval latency, chunk count
5. **Voice/Webhooks** — Call event ingestion rate, webhook signature failures, call duration
6. **Database** — Prisma query latency, connection pool usage
7. **Billing** — Stripe events processed, checkout/portal session creation rate
8. **Compliance** — Checks passed/blocked ratio per workspace
9. **Cache** — Redis hit rate, cache invalidation events
10. **Rate Limiting** — Requests blocked per workspace

**Prometheus metrics to expose (already instrumented via existing metrics.service.ts):**
- `http_requests_total` (method, route, status)
- `http_request_duration_seconds` (histogram)
- `db_query_duration_seconds`
- `cache_operations_total` (hit/miss)
- `llm_generation_duration_seconds`
- `ratelimit_blocked_total`
- `stripe_events_processed_total`
- `voice_webhook_events_total`

**Nginx route:**
```nginx
location /grafana/ {
  proxy_pass http://localhost:3001/;
}
```
Grafana auth: built-in admin user, set via `GF_SECURITY_ADMIN_PASSWORD` env var.

---

### 3. Database Backups

Supabase provides:
- Daily automated backups (kept 7 days on free tier)
- Point-in-time recovery (PITR) on pro tier

**Actions:**
1. Document Supabase backup schedule in `docs/35_BACKUP_RECOVERY.md`
2. Document manual backup procedure using `pg_dump` via Supabase CLI
3. Add backup verification test — weekly restore to staging branch
4. Document RLS + migration strategy for schema changes

**Backup schedule (to document):**
| Type | Frequency | Retention | Notes |
|------|-----------|-----------|-------|
| Supabase auto | Daily | 7 days (free) | PITR on pro |
| `pg_dump` manual | Weekly | 30 days | S3/Blob storage |
| Schema snapshots | Pre-migration | Permanent | Git commit |

---

### 4. Load Testing

Use `k6` (Grafana k6 — open source, JS scripting).

**Test scenarios:**
1. **Agent generation** — Concurrent prompt submissions, measure LLM latency + API p95
2. **Knowledge retrieval** — Concurrent embedding requests + cosine search
3. **Call event ingestion** — Flood webhook endpoint with fake events
4. **Auth flow** — Concurrent signup + JWT validation
5. **Mixed workload** — Realistic 80/20 read/write mix

**Files to create:**
- `load-tests/k6/auth.js` — auth flow scenarios
- `load-tests/k6/agent-generation.js` — LLM generation load
- `load-tests/k6/knowledge-retrieval.js` — embedding + search load
- `load-tests/k6/webhooks.js` — call event ingestion load
- `load-tests/k6/scenarios.js` — mixed baseline scenario
- `load-tests/k6/thresholds.js` — pass/fail criteria

**Thresholds:**
- API p95 latency < 2s for all endpoints
- Error rate < 1%
- Rate limit 0 blocked during load test (set threshold above limit)

---

### 5. Edge Case Testing

Add to existing test suites:

**Auth edge cases:**
- Expired JWT → 401
- Malformed JWT → 401
- JWT for deleted user → 401
- Workspace not found → 403

**Workspace isolation:**
- User A creates agent → User B cannot access
- Cross-workspace knowledge retrieval returns empty
- Cross-workspace call events rejected

**Webhook security:**
- Missing HMAC signature in production → 401
- Invalid HMAC signature → 401
- Replay attack (same event ID twice) → idempotent handling verified

**Concurrency:**
- Concurrent agent version creation → last-write-wins, no data loss
- Concurrent knowledge source upload → all processed
- Concurrent workspace membership update → no duplicate roles

**File upload:**
- Filename with path traversal (`../../etc/passwd`) → sanitized
- Oversized file (>10MB) → rejected
- Unsupported MIME type → rejected

---

## File Map

### Security fixes
| File | Change |
|------|--------|
| `apps/api/src/app.module.ts` | Apply RateLimitGuard globally |
| `apps/api/src/billing/billing.controller.ts` | Add ZodValidationPipe to createPortal |
| `packages/shared/src/schemas/white-label.ts` | Validate logoUrl as https:// URL |
| `apps/api/src/white-label/white-label.service.ts` | Email verification in acceptInvite |
| `apps/api/src/agents/agents.controller.ts` | Add flow validation schema |
| `apps/web/next.config.ts` | CSP + security headers |
| `apps/web/lib/api.ts` | Add X-Requested-With header |
| `apps/web/lib/use-api.ts` | Add X-Requested-With header |

### Observability
| File | Change |
|------|--------|
| `monitoring/prometheus/prometheus.yml` | Create — scrape config |
| `monitoring/grafana/provisioning/dashboards/dashboards.yml` | Create |
| `monitoring/grafana/provisioning/datasources/datasources.yml` | Create |
| `monitoring/grafana/provisioning/dashboards/voiceforge.json` | Create |
| `docker-compose.monitoring.yml` | Create |
| `docker-compose.prod.yml` | Update — add monitoring services |
| `nginx/nginx.conf` | Update — add /grafana route |

### Load testing
| File | Change |
|------|--------|
| `load-tests/k6/auth.js` | Create |
| `load-tests/k6/agent-generation.js` | Create |
| `load-tests/k6/knowledge-retrieval.js` | Create |
| `load-tests/k6/webhooks.js` | Create |
| `load-tests/k6/scenarios.js` | Create |
| `load-tests/k6/thresholds.js` | Create |
| `load-tests/k6/package.json` | Create |

### Documentation
| File | Change |
|------|--------|
| `docs/35_BACKUP_RECOVERY.md` | Create — backup strategy |

### Tests
| File | Change |
|------|--------|
| `apps/api/src/auth/auth.service.test.ts` | Add auth edge case tests |
| `apps/api/src/agents/agents.service.test.ts` | Add workspace isolation tests |
| `apps/api/src/calls/ingest-event.test.ts` | Add webhook security tests |
| `apps/api/src/tools/webhook-executor.test.ts` | Add concurrency tests |
| `apps/api/src/knowledge/knowledge.service.test.ts` | Add file upload edge case tests |

---

## Approach

**Order of implementation:**
1. Security fixes (S1-S7) — quick wins, reduce risk immediately
2. Observability stack — Prometheus + Grafana, deploy with Docker Compose
3. Load tests — establish baseline, identify bottlenecks
4. Edge case tests — fill test coverage gaps
5. Backup documentation — complete the operational picture

**Subagent-driven execution:** dispatch subagents per subsystem for parallel work.

**Rollout:** Security fixes deploy via CI. Prometheus/Grafana added to docker-compose.prod.yml and deployed via existing CD pipeline.