# Phase 10: Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship production-ready: rate limiting, security headers, graceful shutdown, observability (tracing/logging/metrics), load testing, backup docs.

**Architecture:** Security middleware (rate limit via Redis sliding window, helmet, CORS lock-down). Observability via OpenTelemetry (auto-instrumentation + custom spans) + Pino (structured JSON logging). Health endpoint expanded. Load test via k6. Backup strategy documented (no code change needed for AWS RDS snapshots).

**Tech Stack:** `helmet`, `express-rate-limit`, `ioredis`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `pino`, `pino-http`, `k6`

---

## File Map

```
apps/api/src/common/                        — rate-limit.guard.ts + rate-limit.module.ts (NEW)
apps/api/src/common/rate-limit.guard.ts
apps/api/src/common/rate-limit.module.ts
apps/api/src/main.ts                        — add helmet, cors config, graceful shutdown
apps/api/src/health/health.service.ts       — expand health checks (Redis ping, external API probes)
apps/api/src/tracing.ts                     — NEW: OpenTelemetry setup (auto-instrumentation)
apps/api/src/logging.ts                     — NEW: Pino logger factory
apps/api/src/app.module.ts                   — add RateLimitModule + register tracing
k6/                                          — NEW: load test scripts
k6/baseline.js
k6/stress.js
k6/smoke.js
docs/18_DEPLOYMENT_DEVOPS.md                — add backup strategy + load test thresholds
```

---

## Task 1: Rate Limiting

**Files:**
- Create: `apps/api/src/common/rate-limit.guard.ts`
- Create: `apps/api/src/common/rate-limit.module.ts`
- Modify: `apps/api/src/app.module.ts`

### `rate-limit.guard.ts`

Redis-backed sliding window rate limiter using ioredis. Two tiers:
1. **Global** — 1000 req/min per IP (nginx-level, but also enforce here)
2. **Per-workspace** — 120 req/min per authenticated user, key: `ratelimit:workspace:{wsId}:{userId}`

```typescript
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(CACHE_SERVICE) private cache: CacheService,
    private reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const ip = req.ip ?? req.connection.remoteAddress;
    const userId = req.user?.id;

    // Skip for health/read-only endpoints
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (skip) return true;

    // Global limit
    const globalKey = `ratelimit:global:${ip}`;
    const global = await this.cache.get<number>(globalKey);
    if (global !== null && global >= GLOBAL_LIMIT) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.cache.incr(globalKey, 60); // 60s window

    // Per-workspace limit (if authenticated)
    if (userId) {
      const ws = req.params?.ws ?? 'global';
      const wsKey = `ratelimit:ws:${ws}:${userId}`;
      const wsCount = await this.cache.get<number>(wsKey);
      if (wsCount !== null && wsCount >= WORKSPACE_LIMIT) {
        throw new HttpException('Rate limit exceeded for workspace', HttpStatus.TOO_MANY_REQUESTS);
      }
      await this.cache.incr(wsKey, 60);
    }

    return true;
  }
}
```

Add `@SkipRateLimit()` decorator:
```typescript
export const SKIP_RATE_LIMIT = 'skipRateLimit';
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
```

Apply globally in `main.ts` via `app.useGlobalGuards(new RateLimitGuard(...))`, or apply per-controller via `@UseGuards(RateLimitGuard)`.

### `rate-limit.module.ts`
```typescript
@Module({
  imports: [CacheModule],
  providers: [RateLimitGuard],
  exports: [RateLimitGuard],
})
export class RateLimitModule {}
```

Update `CacheService` to support `incr(key, ttlSeconds)` — atomic increment with TTL. If Redis unavailable, fall back to in-memory Map with TTL cleanup (best-effort, don't block).

---

## Task 2: Security Headers + CORS

**Files:**
- Modify: `apps/api/src/main.ts`

```typescript
import helmet from 'helmet';
import cors from 'cors';

// In NestJS bootstrap:
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  noSniff: true,
  frameguard: { action: 'deny' },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-clerk-auth-token'],
  credentials: true,
  maxAge: 86400,
}));
```

Read `ALLOWED_ORIGINS` from env (comma-separated list of frontend URLs).

---

## Task 3: Graceful Shutdown

**Files:**
- Modify: `apps/api/src/main.ts`

```typescript
const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
signals.forEach((sig) => {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  });
});
```

Also log startup banner with version + env + timestamp.

---

## Task 4: Observability — Tracing + Logging

**Files:**
- Create: `apps/api/src/tracing.ts`
- Create: `apps/api/src/logging.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/app.module.ts`

### `tracing.ts`

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ConfigService } from '@nestjs/config';

export function initTracing(config: ConfigService) {
  const otlpUrl = config.get('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (!otlpUrl) return; // disabled if not set

  const sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'voiceforge-api',
    }),
    traceExporter: otlpUrl
      ? new OTLPTraceExporter({ url: `${otlpUrl}/v1/traces` })
      : undefined,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false }, // noisy
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
      }),
    ],
  });

  sdk.start();
  return sdk;
}
```

In `main.ts`, import and call before `app.init()`:
```typescript
import { initTracing } from './tracing';
const sdk = initTracing(configService);
```

### `logging.ts`

```typescript
import pino from 'pino';
import { ConfigService } from '@nestjs/config';

export function createLogger(config: ConfigService) {
  const level = config.get('LOG_LEVEL', 'info');
  return pino({
    level,
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: {
      service: 'voiceforge-api',
      version: process.env.APP_VERSION ?? 'dev',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
```

Replace all `console.log/error/warn` in services with injected `Logger` from NestJS (uses Pino underneath). Set `LOG_LEVEL=debug` in development, `info` in production.

---

## Task 5: Expand Health Endpoint

**Files:**
- Modify: `apps/api/src/health/health.service.ts`

Current: DB ping. Expand to:

```typescript
async check() {
  const results = await Promise.allSettled([
    this.dbHealthCheck(),      // existing: SELECT 1
    this.redisHealthCheck(),   // new: cache.ping()
    this.llmHealthCheck(),     // new: probe OpenAI/GitHub Models health endpoint
  ]);

  const checks = {
    database: results[0].status === 'fulfilled' ? 'ok' : 'error',
    redis: results[1].status === 'fulfilled' ? 'ok' : 'disabled',
    llm: results[2].status === 'fulfilled' ? 'ok' : 'unavailable',
  };

  const healthy = Object.values(checks).every(s => s === 'ok' || s === 'disabled');

  return {
    status: healthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
}
```

Also add `GET /metrics` endpoint (Prometheus format) for `voice_minutes_total`, `active_calls`, `workspace_count` — use `prom-client`.

---

## Task 6: Load Testing Scripts

**Files:**
- Create: `k6/baseline.js`
- Create: `k6/stress.js`
- Create: `k6/smoke.js`

### `k6/baseline.js`

Measure current capacity. Run against local or staging:
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 10 },   // ramp up
    { duration: '5m', target: 10 },   // sustain
    { duration: '2m', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 500ms threshold
    http_req_failed: ['rate<0.01'],
  },
};

export default function() {
  const res = http.get('http://localhost:3001/api/v1/health');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
```

### `k6/stress.js`

Find breaking point:
```javascript
export const options = {
  stages: [
    { duration: '3m', target: 50 },
    { duration: '5m', target: 100 },
    { duration: '3m', target: 200 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'],
  },
};
```

Test endpoints: health, agent list, call list, analytics.

### `k6/smoke.js`

Quick sanity check:
```javascript
export const options = {
  vus: 1,
  duration: '30s',
};
// Tests: health, create agent, publish, make call
```

Add to `docs/18_DEPLOYMENT_DEVOPS.md`: baseline thresholds (p95 < 200ms for health, p95 < 500ms for agent list).

---

## Task 7: Security Review

**Files:**
- Modify: `apps/api/src/common/errors.ts` — add new error codes

Add to error codes:
```typescript
RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',  // HTTP 429
PLAN_LIMIT_EXCEEDED  = 'PLAN_LIMIT_EXCEEDED',  // HTTP 403
```

Also review:
- All user input validation (Zod schemas already cover this)
- SQL injection (Prisma parameterized queries — already safe)
- XSS (Next.js auto-escapes — already safe)
- Auth token expiry enforcement (Clerk already handles)
- Workspace membership checks (WorkspaceGuard already covers)

Add security headers in `main.ts` (Task 2 already covers).

---

## Task 8: Documentation

**Files:**
- Modify: `docs/18_DEPLOYMENT_DEVOPS.md`

Add section:
```markdown
## Backup Strategy

- RDS Automated Backups: 7-day retention, daily snapshots
- Point-in-time recovery: available via RDS console
- Supabase: built-in daily backups + PITR
- Application-level: no backup needed (all state in Postgres)

## Load Testing Thresholds

| Endpoint | p95 Latency Target |
|----------|-------------------|
| GET /api/v1/health | < 100ms |
| GET /api/v1/workspaces/:ws/agents | < 200ms |
| POST /api/v1/workspaces/:ws/agents/generate | < 2000ms |
| GET /api/v1/workspaces/:ws/analytics/workspace | < 500ms |

Baseline: 10 VUs sustained, error rate < 1%.
Stress test: 200 VUs, p99 < 2000ms, no dropped connections.
```

---

## Verification

After all tasks:
1. `npm run typecheck` — all clean
2. `npm run test -w @voiceforge/api` — all pass
3. Health endpoint shows `database`, `redis`, `llm` checks
4. Rate limit returns 429 when exceeded (test with `siege` or wrk)
5. k6 baseline passes thresholds
6. No `console.log` remaining in production paths (use pino logger)