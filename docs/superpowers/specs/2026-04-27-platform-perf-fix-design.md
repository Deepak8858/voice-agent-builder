# Platform Performance Fix — Design

## Context

Every endpoint and every page is slow. Root causes:

1. **Auth hits DB on every request** — `ClerkAuthService.getSessionUser()` runs 2-4 Prisma queries per request, no caching.
2. **CacheService exists but is never used** — Redis/Valued KV is wired but nothing calls it.
3. **N+1 queries in analytics** — `agentMetrics()` loops over agents, firing individual DB calls per agent.
4. **Sequential fetches in Next.js pages** — `/auth/me` runs, then completes before agent list fetch starts.
5. **Missing DB indexes** — `AnalyticsEvent.occurredAt` and `ToolInvocation.startedAt` used in range queries without indexes.

## Goal

Cut p95 API latency 60-80% with minimal changes. All three layers ship together.

---

## Layer 1 — Redis Caching + Parallel Fetches

### API: Cache session user in ClerkAuthService

File: `apps/api/src/auth/clerk-auth.service.ts`

`getSessionUser()` checks Redis first. Key: `vf:v1:session:user:<userId>`. TTL: 5 min.

```
Cache hit  → return cached SessionUser
Cache miss → run existing logic → store in cache → return
```

Also cache workspace+membership lookup. Key: `vf:v1:session:workspace:<workspaceId>`. TTL: 5 min.

Cache invalidation: not needed within 5-min window. On logout, delete both keys.

### API: Cache agent list in AgentsService

File: `apps/api/src/agents/agents.service.ts`

`list()` uses `CacheService.readThrough()`:
- Key: `vf:v1:agents:list:<workspaceId>`
- TTL: 60 sec (agents don't change every second)
- Invalidate on create/update/delete/publish/pause

### API: Cache workspace + membership in WorkspacesService

File: `apps/api/src/workspaces/workspaces.service.ts`

`listForUser()` uses `CacheService.readThrough()`:
- Key: `vf:v1:workspaces:user:<userId>`
- TTL: 5 min

### Frontend: Parallel fetches in dashboard

File: `apps/web/app/dashboard/page.tsx`

Replace sequential:
```ts
const me = await apiFetch<SessionUser>('/auth/me');
const res = await apiFetch<...>(`/workspaces/${me.active_workspace_id}/agents`);
```

With parallel:
```ts
const [me, res] = await Promise.all([
  apiFetch<SessionUser>('/auth/me'),
  apiFetch<...>(`/workspaces/${me.active_workspace_id}/agents`),  // placeholder
]);
// re-order: fetch agents once we have workspaceId
```

Full pattern:
```ts
const me = await apiFetch<SessionUser>('/auth/me');
const [agentsRes] = await Promise.all([
  apiFetch<...>(`/workspaces/${me.active_workspace_id}/agents`),
]);
```

Apply same parallel pattern to `agents/page.tsx` and `analytics/page.tsx`.

---

## Layer 2 — DB Tuning

### Add missing indexes

File: `apps/api/prisma/schema.prisma`

```prisma
// In AnalyticsEvent model, add:
@@index([workspaceId, occurredAt])  // already exists, verify

// In ToolInvocation model, add:
@@index([workspaceId, startedAt])   // already exists, verify

// In Call model, add compound index used by analytics:
@@index([workspaceId, createdAt])
```

Run `npx prisma migrate dev` to apply.

### Fix N+1 in analytics.service.ts agentMetrics()

Current: loop over agents, fire `findMany` + `groupBy` per agent (N queries).

Fix: single `findMany` for all agents in workspace, single `groupBy` for tool stats, single `aggregate` for evals. Compute everything in-memory.

### Prisma connection pool config

File: `apps/api/src/config/env.ts`

Add to DATABASE_URL parsing or connection pool settings:
- `connection_limit=10` (default is small)
- `pool_timeout=10`
- `connect_timeout=10`

---

## Layer 3 — Auth Guard Short-Circuit

### Skip auth guard for public routes

File: `apps/api/src/common/workspace.guard.ts`

Add route exclusion list for health, auth (login/signup), and public templates.

### Cache response header

Add `X-Cache-Hit: true/false` header on cached endpoints to verify cache working in dev.

---

## Files to Change

| File | Change |
|------|--------|
| `apps/api/src/auth/clerk-auth.service.ts` | Add Redis cache for session user + workspace |
| `apps/api/src/agents/agents.service.ts` | Cache agent lists with readThrough |
| `apps/api/src/workspaces/workspaces.service.ts` | Cache workspace list per user |
| `apps/api/src/common/cache-invalidator.ts` | New: invalidate on write operations |
| `apps/api/prisma/schema.prisma` | Verify/add compound indexes |
| `apps/api/src/analytics/analytics.service.ts` | Fix N+1 in agentMetrics |
| `apps/api/src/config/env.ts` | Add connection pool env vars |
| `apps/web/app/dashboard/page.tsx` | Parallel fetch with Promise.all |
| `apps/web/app/dashboard/agents/page.tsx` | Parallel fetch with Promise.all |
| `apps/web/app/dashboard/analytics/page.tsx` | Parallel fetch with Promise.all |

---

## Testing

1. Start Redis/Valued KV locally
2. Hit `/api/v1/health` — should return fast
3. Hit agent list endpoint twice — second call should have `X-Cache-Hit: true`
4. Check `KEYS vf:v1:*` in Redis — should contain session + agent keys
5. Create new agent — cache should invalidate, next list fetch misses cache and repopulates
6. Run analytics dashboard — should load without N+1 queries in DB logs
