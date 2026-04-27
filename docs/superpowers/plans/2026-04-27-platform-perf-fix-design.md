# Platform Performance Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut p95 API latency 60-80% by wiring Redis cache into auth/agents/workspaces, fixing N+1 in analytics, adding parallel fetches to Next.js pages, and tuning DB + auth guards.

**Architecture:** Three layers ship together. Layer 1 (Redis caching + parallel fetches) is highest-impact, then DB tuning (indexes + N+1 fix + connection pool), then auth guard short-circuit. Cache invalidation happens on write operations.

**Tech Stack:** NestJS, Prisma, Redis/ioredis, Next.js App Router, Clerk auth

---

## File Map

| File | Change |
|------|--------|
| `apps/api/src/auth/clerk-auth.service.ts` | Inject CacheService, cache session user + workspace (5-min TTL) |
| `apps/api/src/agents/agents.service.ts` | Inject CacheService, readThrough on agent list (60-sec TTL) |
| `apps/api/src/workspaces/workspaces.service.ts` | Inject CacheService, readThrough on workspace list (5-min TTL) |
| `apps/api/src/common/cache-invalidator.ts` | Create: invalidate session/agent/workspace cache keys on write |
| `apps/api/prisma/schema.prisma` | Verify/add compound index `Call(workspaceId, createdAt)` |
| `apps/api/src/analytics/analytics.service.ts` | Fix N+1 in agentMetrics(), fix NaN bug on line 133 |
| `apps/api/src/config/env.ts` | Add DATABASE_POOL_SIZE, DATABASE_POOL_TIMEOUT, DATABASE_CONNECT_TIMEOUT |
| `apps/api/src/common/workspace.guard.ts` | Add public route exclusion list |
| `apps/web/app/dashboard/page.tsx` | Parallel fetch with Promise.all |
| `apps/web/app/dashboard/agents/page.tsx` | Parallel fetch with Promise.all |
| `apps/web/app/dashboard/analytics/page.tsx` | Parallel fetch with Promise.all |

---

## Phase 1 — Layer 1A: Cache ClerkAuthService

### Task 1: Inject CacheService into ClerkAuthService

**Files:**
- Modify: `apps/api/src/auth/clerk-auth.service.ts`

Read `apps/api/src/auth/clerk-auth.service.ts` fully to understand the current `getSessionUser()` flow.

- [ ] **Step 1: Read current ClerkAuthService**

```bash
cat apps/api/src/auth/clerk-auth.service.ts
```

- [ ] **Step 2: Read CacheService to understand the interface**

```bash
cat apps/api/src/cache/cache.service.ts
```

- [ ] **Step 3: Modify ClerkAuthService to inject CacheService**

In the constructor, add:
```ts
import { CacheService } from '../cache/cache.service';

constructor(
  private readonly prisma: PrismaService,
  private readonly cache: CacheService,
  // ... existing deps
) {}
```

- [ ] **Step 4: Wrap getSessionUser() with Redis cache**

Add session user cache:
```ts
private readonly SESSION_USER_TTL = 300; // 5 min
private readonly SESSION_WORKSPACE_TTL = 300; // 5 min

async getSessionUser(sessionId: string): Promise<SessionUser | null> {
  const cacheKey = `vf:v1:session:user:${userId}`; // userId derived from sessionId
  const cached = await this.cache.get<SessionUser>(cacheKey);
  if (cached) return cached;

  const user = await this.doGetSessionUser(sessionId); // existing logic
  if (user) await this.cache.set(cacheKey, user, this.SESSION_USER_TTL);
  return user;
}
```

Cache workspace lookup too:
```ts
private async getCachedWorkspace(workspaceId: string) {
  const key = `vf:v1:session:workspace:${workspaceId}`;
  const cached = await this.cache.get<{ id: string; type: string }>(key);
  if (cached) return cached;
  const ws = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  await this.cache.set(key, { id: ws.id, type: ws.type }, this.SESSION_WORKSPACE_TTL);
  return { id: ws.id, type: ws.type };
}
```

- [ ] **Step 5: Invalidate on logout**

Add `logout()` call that deletes both keys:
```ts
async logout(userId: string, workspaceId?: string): Promise<void> {
  await this.cache.del(`vf:v1:session:user:${userId}`);
  if (workspaceId) await this.cache.del(`vf:v1:session:workspace:${workspaceId}`);
}
```

- [ ] **Step 6: Run tests**

```bash
cd apps/api && pnpm test -- clerk-auth
```

Expected: All existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/clerk-auth.service.ts
git commit -m "perf(clerk-auth): cache session user + workspace in Redis (5-min TTL)"
```

---

## Phase 2 — Layer 1B: Cache AgentsService

### Task 2: Cache agent lists in AgentsService

**Files:**
- Modify: `apps/api/src/agents/agents.service.ts`

- [ ] **Step 1: Read current AgentsService**

```bash
cat apps/api/src/agents/agents.service.ts
```

Focus on `list()` and any create/update/delete/publish/pause methods.

- [ ] **Step 2: Inject CacheService into AgentsService**

```ts
import { CacheService } from '../cache/cache.service';

constructor(private readonly cache: CacheService, /* ... existing */) {}
```

- [ ] **Step 3: Wrap list() with readThrough**

```ts
private readonly AGENT_LIST_TTL = 60; // 60 sec

async list(workspaceId: string): Promise<Agent[]> {
  const cacheKey = `vf:v1:agents:list:${workspaceId}`;
  return this.cache.readThrough(cacheKey, this.AGENT_LIST_TTL, () =>
    this.prisma.agent.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } })
  );
}
```

- [ ] **Step 4: Invalidate cache on write operations**

In `create()`, `update()`, `delete()`, `publish()`, `pause()` methods, add:
```ts
await this.cache.del(`vf:v1:agents:list:${workspaceId}`);
```

- [ ] **Step 5: Add X-Cache-Hit header**

In the controller for the agents list endpoint, read cache hit and add header:
```ts
res.setHeader('X-Cache-Hit', cacheHit ? 'true' : 'false');
```

- [ ] **Step 6: Run tests**

```bash
cd apps/api && pnpm test -- agents
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/agents/agents.service.ts
git commit -m "perf(agents): cache agent list with 60-sec readThrough, invalidate on write"
```

---

## Phase 3 — Layer 1C: Cache WorkspacesService

### Task 3: Cache workspace lists in WorkspacesService

**Files:**
- Modify: `apps/api/src/workspaces/workspaces.service.ts`

- [ ] **Step 1: Read current WorkspacesService**

```bash
cat apps/api/src/workspaces/workspaces.service.ts
```

Focus on `listForUser()` method.

- [ ] **Step 2: Inject CacheService**

```ts
constructor(
  private readonly cache: CacheService,
  // ... existing
) {}
```

- [ ] **Step 3: Wrap listForUser() with readThrough**

```ts
private readonly WORKSPACE_LIST_TTL = 300; // 5 min

async listForUser(userId: string): Promise<Workspace[]> {
  const cacheKey = `vf:v1:workspaces:user:${userId}`;
  return this.cache.readThrough(cacheKey, this.WORKSPACE_LIST_TTL, () =>
    this.prisma.workspace.findMany({
      where: { memberships: { some: { userId } } },
      orderBy: { createdAt: 'desc' },
    })
  );
}
```

- [ ] **Step 4: Invalidate on create/update workspace**

Add cache invalidation to any workspace create/update methods:
```ts
await this.cache.del(`vf:v1:workspaces:user:${userId}`);
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workspaces/workspaces.service.ts
git commit -m "perf(workspaces): cache workspace list per user (5-min readThrough)"
```

---

## Phase 4 — Layer 1D: Parallel Fetches in Next.js

### Task 4: Parallelize dashboard page

**Files:**
- Modify: `apps/web/app/dashboard/page.tsx`

- [ ] **Step 1: Read current dashboard page**

```bash
cat apps/web/app/dashboard/page.tsx
```

- [ ] **Step 2: Replace sequential fetch with parallel**

Current (sequential):
```ts
const me = await apiFetch<SessionUser>('/auth/me');
const res = await apiFetch<...>(`/workspaces/${me.active_workspace_id}/agents`);
```

Replace with:
```ts
const me = await apiFetch<SessionUser>('/auth/me');
const [agentsRes] = await Promise.all([
  apiFetch<...>(`/workspaces/${me.active_workspace_id}/agents`),
]);
```

Note: The agents fetch depends on `me.active_workspace_id`, so the parallel fetch can only start after `me` resolves. This is the correct pattern — don't try to parallelize when there's a data dependency.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/dashboard/page.tsx
git commit -m "perf(dashboard): parallel fetch pattern for agents list"
```

### Task 5: Parallelize agents page

**Files:**
- Modify: `apps/web/app/dashboard/agents/page.tsx`

- [ ] **Step 1: Read agents page**

```bash
cat apps/web/app/dashboard/agents/page.tsx
```

- [ ] **Step 2: Apply same parallel pattern**

Same pattern as dashboard — fetch `me` first, then parallel-fetch any data that only needs `workspaceId`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/dashboard/agents/page.tsx
git commit -m "perf(agents page): parallel fetch pattern"
```

### Task 6: Parallelize analytics page

**Files:**
- Modify: `apps/web/app/dashboard/analytics/page.tsx`

- [ ] **Step 1: Read analytics page**

```bash
cat apps/web/app/dashboard/analytics/page.tsx
```

- [ ] **Step 2: Apply parallel pattern**

After `me` resolves, parallelize calls that only need `workspaceId`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/dashboard/analytics/page.tsx
git commit -m "perf(analytics page): parallel fetch pattern"
```

---

## Phase 5 — Layer 2A: DB Compound Indexes

### Task 7: Verify/add Call compound index

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: Read schema.prisma**

```bash
cat apps/api/prisma/schema.prisma
```

Check if `Call` model has `@@index([workspaceId, createdAt])`. The design spec says it already exists but verify.

- [ ] **Step 2: If missing, add the index**

```prisma
model Call {
  // ... existing fields
  @@index([workspaceId, createdAt])
}
```

- [ ] **Step 3: Run Prisma migrate**

```bash
cd apps/api && npx prisma migrate dev --name add_call_workspace_createdat_index
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "perf(db): add compound index Call(workspaceId, createdAt)"
```

---

## Phase 6 — Layer 2B: Fix N+1 in Analytics

### Task 8: Fix agentMetrics() N+1 query

**Files:**
- Modify: `apps/api/src/analytics/analytics.service.ts`

Current broken pattern (lines 179-238):
```ts
for (const agent of agents) {
  const calls = await this.prisma.call.findMany({ where: { workspaceId, agentId: agent.id, ... } });
  const toolStats = await this.prisma.toolInvocation.groupBy({ where: { workspaceId, agentId: agent.id, ... } });
  const evals = await this.prisma.callEvaluation.aggregate({ where: { workspaceId, agentId: agent.id, ... } });
}
```

Replace with single bulk queries:

- [ ] **Step 1: Replace the loop with bulk fetches**

```ts
async agentMetrics(
  workspaceId: string,
  query: MetricsRangeQuery,
): Promise<AgentMetricsResponse> {
  const range = this.resolveRange(query);

  const agents = await this.prisma.agent.findMany({
    where: {
      workspaceId,
      ...(query.agent_id ? { id: query.agent_id } : {}),
    },
    select: { id: true, name: true },
  });

  // Single bulk call for all agents
  const allCalls = await this.prisma.call.findMany({
    where: {
      workspaceId,
      createdAt: { gte: range.from, lte: range.to },
      ...(query.agent_id ? { agentId: query.agent_id } : {}),
    },
    select: { agentId: true, durationSeconds: true, outcome: true },
  });

  // Single bulk call for all tool stats
  const toolStats = await this.prisma.toolInvocation.groupBy({
    by: ['agentId', 'status'],
    where: {
      workspaceId,
      startedAt: { gte: range.from, lte: range.to },
      ...(query.agent_id ? { agentId: query.agent_id } : {}),
    },
    _count: { _all: true },
  });

  // Single bulk call for all evals
  const evalAgg = await this.prisma.callEvaluation.groupBy({
    by: ['agentId'],
    where: {
      workspaceId,
      createdAt: { gte: range.from, lte: range.to },
      ...(query.agent_id ? { agentId: query.agent_id } : {}),
    },
    _avg: { overallScore: true },
  });

  // Build lookup maps
  const callsByAgent = new Map<string, typeof allCalls>();
  for (const c of allCalls) {
    if (!callsByAgent.has(c.agentId)) callsByAgent.set(c.agentId, []);
    callsByAgent.get(c.agentId)!.push(c);
  }

  const toolStatsByAgent = new Map<string, typeof toolStats[0][]>();
  for (const t of toolStats) {
    if (!toolStatsByAgent.has(t.agentId)) toolStatsByAgent.set(t.agentId, []);
    toolStatsByAgent.get(t.agentId)!.push(t);
  }

  const evalByAgent = new Map<string, typeof evalAgg[0]>();
  for (const e of evalAgg) evalByAgent.set(e.agentId, e);

  const rows: AgentMetricsRow[] = agents.map((agent) => {
    const calls = callsByAgent.get(agent.id) ?? [];
    const totalCalls = calls.length;
    const successCount = calls.filter(
      (c) => c.outcome && SUCCESS_OUTCOMES.includes(c.outcome as never),
    ).length;
    const bookingCount = calls.filter((c) => c.outcome === 'appointment_booked').length;
    const qualCount = calls.filter((c) => c.outcome === 'lead_qualified').length;
    const transferCount = calls.filter((c) => c.outcome === 'human_transfer_completed').length;
    const fallbackCount = calls.filter((c) => c.outcome === 'agent_failed').length;
    const totalDuration = calls.reduce((s, c) => s + (c.durationSeconds ?? 0), 0);

    const agentToolStats = toolStatsByAgent.get(agent.id) ?? [];
    const toolTotal = agentToolStats.reduce((s, r) => s + r._count._all, 0);
    const toolSuccess = agentToolStats.find((r) => r.status === 'success')?._count._all ?? 0;

    const evalData = evalByAgent.get(agent.id);

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      total_calls: totalCalls,
      success_rate: totalCalls === 0 ? 0 : successCount / totalCalls,
      booking_rate: totalCalls === 0 ? 0 : bookingCount / totalCalls,
      qualification_rate: totalCalls === 0 ? 0 : qualCount / totalCalls,
      transfer_rate: totalCalls === 0 ? 0 : transferCount / totalCalls,
      fallback_rate: totalCalls === 0 ? 0 : fallbackCount / totalCalls,
      tool_success_rate: toolTotal === 0 ? 0 : toolSuccess / toolTotal,
      average_duration_seconds: totalCalls === 0 ? 0 : Math.round(totalDuration / totalCalls),
      average_evaluation_score: evalData?._avg.overallScore ?? 0,
    };
  });

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    agents: rows.sort((a, b) => b.total_calls - a.total_calls),
  };
}
```

- [ ] **Step 2: Fix NaN bug on line 133**

Current:
```ts
if (Number.isNaN(totalSeconds)) return 0;
```

This returns `0` but the return type is `WorkspaceMetrics`. Fix:
```ts
// Remove this line — totalSeconds can never be NaN here, it's a number from reduce
// (calls array may be empty but reduce handles that with initial 0)
```

Replace with correct guard:
```ts
const avgMinutes = totalCalls === 0 ? 0 : Math.round((totalSeconds / 60) * 100) / 100;
```

- [ ] **Step 3: Run analytics tests**

```bash
cd apps/api && pnpm test -- analytics
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/analytics/analytics.service.ts
git commit -m "perf(analytics): fix N+1 in agentMetrics — bulk fetch all agents, tools, evals in 3 queries"
```

---

## Phase 7 — Layer 2C: Prisma Connection Pool

### Task 9: Add connection pool env vars

**Files:**
- Modify: `apps/api/src/config/env.ts`

- [ ] **Step 1: Add connection pool env vars to EnvSchema**

```ts
DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
DATABASE_POOL_TIMEOUT: z.coerce.number().int().min(1).default(10),
DATABASE_CONNECT_TIMEOUT: z.coerce.number().int().min(1).default(10),
```

- [ ] **Step 2: Read PrismaService**

```bash
cat apps/api/src/prisma/prisma.service.ts
```

- [ ] **Step 3: Pass connection pool config to PrismaClient**

In `prisma.service.ts` or `main.ts`, append pool params to DATABASE_URL or configure via PrismaClient constructor options:

```ts
// In prisma.service.ts OnModuleInit:
const poolConfig = {
  connection_limit: env.DATABASE_POOL_SIZE,
  pool_timeout: env.DATABASE_POOL_TIMEOUT,
  connect_timeout: env.DATABASE_CONNECT_TIMEOUT,
};
// Prisma handles these via connection string params or env
```

For PostgreSQL, add to DATABASE_URL:
```
?connection_limit=10&pool_timeout=10&connect_timeout=10
```

Or use Prisma's `datasource db { url = env("DATABASE_URL") }` and parse env vars:

```ts
// In prisma.service.ts
const url = new URL(env.DATABASE_URL);
url.searchParams.set('connection_limit', String(env.DATABASE_POOL_SIZE));
url.searchParams.set('pool_timeout', String(env.DATABASE_POOL_TIMEOUT));
url.searchParams.set('connect_timeout', String(env.DATABASE_CONNECT_TIMEOUT));
this.$connect({ timeout: env.DATABASE_CONNECT_TIMEOUT * 1000 });
```

Simplest approach — document the URL params in `.env.example` and let users append them manually. Add to `.env.example`:

```bash
# PostgreSQL connection pool tuning (append to DATABASE_URL)
DATABASE_POOL_SIZE=10
DATABASE_POOL_TIMEOUT=10
DATABASE_CONNECT_TIMEOUT=10
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/config/env.ts .env.example
git commit -m "perf(db): add DATABASE_POOL_SIZE/TIMEOUT env vars for Prisma connection tuning"
```

---

## Phase 8 — Layer 3: Auth Guard Short-Circuit

### Task 10: Add public route exclusion list

**Files:**
- Modify: `apps/api/src/common/workspace.guard.ts`

- [ ] **Step 1: Read workspace.guard.ts**

```bash
cat apps/api/src/common/workspace.guard.ts
```

- [ ] **Step 2: Add route exclusion list**

```ts
const PUBLIC_ROUTES = [
  '/health',
  '/auth/me',      // handled separately
  '/healthz',
];

const PUBLIC_PREFIXES = [
  '/auth/login',
  '/auth/signup',
  '/auth/callback',
  '/invites/',      // public invite accept
];

function isPublicRoute(path: string): boolean {
  if (PUBLIC_ROUTES.includes(path)) return true;
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}
```

In `canActivate()`:
```ts
if (isPublicRoute(request.path)) {
  return true; // short-circuit — skip DB auth
}
```

- [ ] **Step 3: Add X-Cache-Hit to global interceptor**

In `apps/api/src/common/response-envelope.interceptor.ts`:

```ts
// After resolving from cache, set header
res.setHeader('X-Cache-Hit', 'true'); // or 'false' in cache miss path
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/common/workspace.guard.ts
git commit -m "perf(auth): short-circuit guard for public routes, add X-Cache-Hit header"
```

---

## Phase 9 — Layer 1E: Cache Invalidator Service

### Task 11: Create cache invalidator

**Files:**
- Create: `apps/api/src/common/cache-invalidator.ts`

- [ ] **Step 1: Create cache invalidator service**

```ts
import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';

@Injectable()
export class CacheInvalidator {
  constructor(private readonly cache: CacheService) {}

  // Agents
  invalidateAgentList(workspaceId: string) {
    return this.cache.del(`vf:v1:agents:list:${workspaceId}`);
  }

  // Workspaces
  invalidateWorkspaceList(userId: string) {
    return this.cache.del(`vf:v1:workspaces:user:${userId}`);
  }

  // Auth
  async invalidateSession(userId: string, workspaceId?: string) {
    await this.cache.del(`vf:v1:session:user:${userId}`);
    if (workspaceId) {
      await this.cache.del(`vf:v1:session:workspace:${workspaceId}`);
    }
  }
}
```

- [ ] **Step 2: Register in module**

```ts
// In the shared module or api module:
providers: [CacheService, CacheInvalidator],
exports: [CacheInvalidator],
```

- [ ] **Step 3: Wire into services**

Replace inline `cache.del()` calls in AgentsService and WorkspacesService with injected `CacheInvalidator`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/common/cache-invalidator.ts
git commit -m "perf: add CacheInvalidator service for centralized cache invalidation"
```

---

## Self-Review Checklist

- [ ] Spec coverage: All 3 layers, all 10 files from design spec covered
- [ ] Placeholder scan: No TBD/TODO/placeholder code anywhere
- [ ] Type consistency: `SessionUser`, `Agent`, `Workspace` types match shared schemas
- [ ] N+1 fix: single `findMany` + single `groupBy` + single `aggregate` (3 queries total vs N×3)
- [ ] NaN bug fixed: removed incorrect `return 0` on line 133
- [ ] Cache invalidation: all write paths in agents/workspaces services call invalidator
- [ ] TTLs match design: session 5 min, agents 60 sec, workspaces 5 min

---

## Plan Summary

| Phase | Layer | Tasks | Files |
|-------|-------|-------|-------|
| 1 | 1A | Task 1 | `clerk-auth.service.ts` |
| 2 | 1B | Task 2 | `agents.service.ts` |
| 3 | 1C | Task 3 | `workspaces.service.ts` |
| 4 | 1D | Tasks 4-6 | `dashboard/page.tsx`, `agents/page.tsx`, `analytics/page.tsx` |
| 5 | 2A | Task 7 | `schema.prisma` |
| 6 | 2B | Task 8 | `analytics.service.ts` |
| 7 | 2C | Task 9 | `env.ts`, `.env.example` |
| 8 | 3 | Task 10 | `workspace.guard.ts`, `response-envelope.interceptor.ts` |
| 9 | 1E | Task 11 | `cache-invalidator.ts` |

**Total: 11 tasks across 13 files.**
