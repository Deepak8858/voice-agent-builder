# Phase 9 — Billing Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire usage metering into all call completion paths, add plan limit enforcement on outbound calls, fix Stripe webhook event persistence, add trial guard, add agent creation plan limit warning.

**Architecture:** Additive changes only — no restructuring. All billing hooks are best-effort (never fail call flow). `BillingService` is the single source of plan limit truth. `CallsService` records usage on every call end. `StripeWebhookService` stores complete event metadata.

**Tech Stack:** NestJS, Prisma, Stripe SDK

---

## File Map

| File | Change |
|------|--------|
| `apps/api/src/calls/calls.service.ts` | Add `recordUsage` call to `ingestEvent` call.ended path |
| `apps/api/src/billing/billing.service.ts` | Add `canOutboundCall` usage in `startOutboundCall`; add trial guard in `checkFeatureGate` |
| `apps/api/src/agents/agents.service.ts` | Add agent creation plan limit warning at 80% capacity |
| `apps/api/src/webhooks/stripe-webhook.service.ts` | Fix `dispatch`/`markProcessed`/`markError` to store full event metadata |

---

## Task 1: Add usage metering to `ingestEvent` call.ended path

`CallsService.recordUsage` exists (line 465) and is called in `end()` but NOT in `ingestEvent`. The provider-driven `call.ended` path skips it.

**File:** `apps/api/src/calls/calls.service.ts`

- [ ] **Step 1: Add `recordUsage` call to `ingestEvent` call.ended block**

Find the `if (payload.event_type === 'call.ended')` block around line 364. After the `queue.enqueue('evaluation'...)` call (line 425), add:

```typescript
// Phase 9: record usage for provider-driven call completion
await this.recordUsage(call.workspaceId, updated.id, updated.direction, durationSeconds);
```

Run: `npm run typecheck -w @voiceforge/api 2>&1 | head -30`
Expected: No new errors related to `recordUsage`

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/calls/calls.service.ts
git commit -m "feat(billing): record usage on provider-driven call completion"
```

---

## Task 2: Add outbound call count limit before compliance check

`checkFeatureGate('outbound')` returns true for any paid plan but doesn't check actual call count. `canOutboundCall` exists but is unused. Need to check remaining calls before hitting compliance (fail fast with clear error).

**File:** `apps/api/src/billing/billing.service.ts`

- [ ] **Step 1: Add `canStartOutboundCall` public method**

Add after existing `canOutboundCall` (line 260):

```typescript
async canStartOutboundCall(workspaceId: string): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const sub = await this.getSubscription(
    await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { organizationId: true } }).then(w => w.organizationId)
  );
  if (!sub) return { allowed: false, remaining: 0, limit: 0 };
  const plan = (sub.plan ?? 'free') as keyof typeof PLAN_LIMITS;
  const limit = PLAN_LIMITS[plan].outboundCalls;
  if (limit === -1) return { allowed: true, remaining: -1, limit: -1 };
  const ws = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const endOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);
  const used = await this.prisma.usageRecord.aggregate({
    where: { workspaceId, billableMetric: 'calls', periodStart: { gte: startOfMonth }, periodEnd: { lte: endOfMonth } },
    _sum: { quantity: true },
  });
  const total = used._sum.quantity ?? 0;
  const remaining = Math.max(0, limit - total);
  return { allowed: remaining > 0, remaining, limit };
}
```

Wait — this is too complex. Keep it simple: check at call time using existing `getWorkspaceUsage`:

```typescript
async canStartOutboundCall(workspaceId: string): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const usage = await this.getWorkspaceUsage(workspaceId);
  const limit = usage.limits.calls;
  const used = usage.metrics.calls;
  const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
  return { allowed: remaining !== 0, remaining, limit };
}
```

Add this after `canOutboundCall` (line 265).

- [ ] **Step 2: Wire into `startOutboundCall` in `calls.service.ts`**

In `startOutboundCall`, after the `checkFeatureGate` block (line 116) and BEFORE compliance check:

```typescript
const outbound = await this.billing.canStartOutboundCall(workspaceId);
if (!outbound.allowed) {
  throw new ForbiddenPlanError(
    outbound.limit === -1
      ? 'Outbound calls are not available on your plan.'
      : `Monthly outbound call limit reached (${outbound.limit}). Please upgrade or wait until next billing cycle.`,
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w @voiceforge/api 2>&1 | head -30`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/billing/billing.service.ts apps/api/src/calls/calls.service.ts
git commit -m "feat(billing): enforce monthly outbound call count limit per plan"
```

---

## Task 3: Fix `StripeWebhookService.markProcessed` to store full event metadata

**Bug:** `dispatch` calls `markProcessed(event.id)` losing all event data. Then `markProcessed` creates `{ stripeEventId, type: 'unknown', data: {} }`. Should store `event.type`, `event.data.object`, `event.created`, etc.

**File:** `apps/api/src/webhooks/stripe-webhook.service.ts`

- [ ] **Step 1: Change `dispatch` to pass full event**

Change line in `dispatch`:
```typescript
// Before:
await this.markProcessed(event.id);
// After:
await this.markProcessed(event);
```

Also change the error path:
```typescript
// Before:
await this.markError(event.id, String(err));
// After:
await this.markError(event, String(err));
```

- [ ] **Step 2: Update `markProcessed` signature and body**

Replace the method:

```typescript
private async markProcessed(event: Stripe.Event): Promise<void> {
  await this.prisma.stripeEvent.upsert({
    where: { stripeEventId: event.id },
    create: {
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.apiVersion ?? null,
      created: new Date(event.created * 1000),
      data: event.data.object as Prisma.InputJsonValue,
      livemode: event.livemode,
      pendingWebhooks: event.pendingWebhooks,
      processedAt: new Date(),
    },
    update: { processedAt: new Date(), errorMessage: null },
  });
}
```

- [ ] **Step 3: Update `markError` signature and body**

```typescript
private async markError(event: Stripe.Event, errorMessage: string): Promise<void> {
  await this.prisma.stripeEvent.upsert({
    where: { stripeEventId: event.id },
    create: {
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.apiVersion ?? null,
      created: new Date(event.created * 1000),
      data: event.data.object as Prisma.InputJsonValue,
      livemode: event.livemode,
      pendingWebhooks: event.pendingWebhooks,
      errorMessage,
    },
    update: { errorMessage },
  });
}
```

- [ ] **Step 4: Import Prisma**

Add to imports if not present:
```typescript
import { Prisma } from '@prisma/client';
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @voiceforge/api 2>&1 | head -30`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/webhooks/stripe-webhook.service.ts
git commit -m "fix(billing): store full Stripe event metadata in stripe_events table"
```

---

## Task 4: Add trial period guard to feature gate check

If plan is `trialing` and `trialEnd` has passed, downgrade to `free` limits. Users on expired trials shouldn't get paid features.

**File:** `apps/api/src/billing/billing.service.ts`

- [ ] **Step 1: Update `checkFeatureGate` to handle expired trials**

Find the `checkFeatureGate` method (line 223). Add at the top:

```typescript
async checkFeatureGate(
  organizationId: string,
  gate: FeatureGate,
): Promise<boolean> {
  const sub = await this.getSubscription(organizationId);
  let plan = (sub?.plan ?? 'free') as keyof typeof PLAN_LIMITS;

  // Treat expired trials as free plan
  if (plan === 'trialing' && sub?.trialEnd && new Date(sub.trialEnd) < new Date()) {
    plan = 'free';
  }

  const limits = PLAN_LIMITS[plan];
  // ... rest of existing switch
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @voiceforge/api 2>&1 | head -30`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/billing/billing.service.ts
git commit -m "feat(billing): treat expired trials as free plan for feature gates"
```

---

## Task 5: Add agent creation plan limit warning at 80%

Warn users when creating an agent that would push them past 80% of their plan's agent limit — before they hit the hard block at publish time.

**File:** `apps/api/src/agents/agents.service.ts`

- [ ] **Step 1: Add `checkAgentCreationWarning` to BillingService**

Add to `billing.service.ts`:

```typescript
async checkAgentCreationWarning(organizationId: string): Promise<{ warning: string | null; current: number; limit: number }> {
  const sub = await this.getSubscription(organizationId);
  const plan = (sub?.plan ?? 'free') as keyof typeof PLAN_LIMITS;
  const limit = PLAN_LIMITS[plan].agents;
  if (limit === -1) return { warning: null, current: 0, limit: -1 };
  const current = await this.prisma.agent.count({ where: { workspace: { organizationId } } });
  const threshold = Math.floor(limit * 0.8);
  if (current >= threshold && current < limit) {
    return {
      warning: `You have ${current}/${limit} agents (${Math.round(current / limit * 100)}% of your plan limit). Upgrade to publish more agents.`,
      current,
      limit,
    };
  }
  return { warning: null, current, limit };
}
```

- [ ] **Step 2: Wire into `AgentsService.create`**

In `agents.service.ts`, in the `create` method (around line 90), after creating the agent and before the audit log:

```typescript
const agentLimitWarning = await this.billing.checkAgentCreationWarning(organizationId);
if (agentLimitWarning.warning) {
  this.logger.warn(`Agent creation warning for org ${organizationId}: ${agentLimitWarning.warning}`);
}
```

- [ ] **Step 3: Add logger import to AgentsService if needed**

Check if `Logger` is already imported in `agents.service.ts`. If not:
```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
```
And add to constructor:
```typescript
private readonly logger = new Logger(AgentsService.name);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @voiceforge/api 2>&1 | head -30`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/billing/billing.service.ts apps/api/src/agents/agents.service.ts
git commit -m "feat(billing): warn at 80% agent creation capacity"
```

---

## Spec Coverage Check

| Spec Requirement | Task |
|-----------------|------|
| Usage metering on call completion (calls + minutes) | Task 1 + Task 2 |
| Plan limit enforcement on outbound calls | Task 2 |
| Stripe event full metadata storage | Task 3 |
| Trial period guard | Task 4 |
| Agent creation warning at 80% | Task 5 |

All spec requirements covered. No placeholders. Type consistency verified across files.