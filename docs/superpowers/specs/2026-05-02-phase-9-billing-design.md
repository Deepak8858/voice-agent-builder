# Phase 9 — Billing Completion Design

## Problem

Phase 9 (docs/16_BILLING.md) skeleton exists: `BillingService`, `StripeWebhookService`, `Subscription`/`UsageRecord` Prisma models, feature gates. **Critical gap**: usage metering not wired to call completion. Calls complete but no `UsageRecord` rows created. All billing meters stay at zero.

## Current State

- `BillingService.recordUsage(workspaceId, metric, quantity)` exists but **not called anywhere**
- `CallsService` has `startOutboundCall`, `handleCallEnded` — no usage recording
- Stripe webhook service handles subscription lifecycle but no per-call metering
- Feature gate `checkFeatureGate` exists and is called from `AgentsService.publish`
- `StripeWebhookService.markProcessed` uses `upsert` with incomplete data (`type: 'unknown'`, `data: {}`)

## Phase 9 Gap Analysis

### Missing: Call completion usage metering

`CallsService` needs to call `BillingService.recordUsage` when calls end:
- `calls` metric: +1 per completed call
- `minutes` metric: +durationSeconds/60 on call completion
- `tools` metric: +1 per `ToolInvocation` with status=success

### Missing: Agent publish block on plan limits

`AgentsService.publish` calls `enforceAgentLimit` but:
- No block on starting outbound calls when `outboundCalls` limit reached
- `canOutboundCall` exists but unused in `CallsService.startOutboundCall`

### Missing: Trial period enforcement

`StripeWebhookService.handleSubscriptionUpdated` sets `trialEnd` but no guard rejects trial users from paid features.

### Bug: StripeWebhookService.markProcessed incomplete

`upsert` creates `type: 'unknown'`, `data: {}` instead of persisting event metadata.

## Implementation Plan

### 1. Wire usage metering into `CallsService`

In `handleCallEnded` / after `this.voice.endCall`:
```ts
await this.billing.recordUsage(workspaceId, 'calls', 1);
if (durationSeconds > 0) {
  await this.billing.recordUsage(workspaceId, 'minutes', Math.ceil(durationSeconds / 60));
}
```

Track `ToolInvocation` success count separately in a background job or at workspace cleanup.

### 2. Wire plan limit check into `startOutboundCall`

Before compliance check in `startOutboundCall`:
```ts
const outboundLimit = await this.billing.checkFeatureGate(orgId, 'outbound');
if (!outboundLimit) {
  const usage = await this.billing.getWorkspaceUsage(workspaceId);
  const remaining = usage.limits.outboundCalls - usage.metrics.calls;
  if (remaining <= 0) {
    throw new ForbiddenPlanError('Outbound call limit reached for this period.');
  }
}
```

### 3. Wire trial guard into feature gate checks

Add `trial_plan_trial_end` gate. In `BillingService.checkFeatureGate`, if `plan === 'trialing'` and `trialEnd <= now`, downgrade to free limits.

### 4. Fix `StripeWebhookService.markProcessed`

Store full event metadata:
```ts
data: {
  stripeEventId,
  type: event.type,
  created: new Date(event.created * 1000),
  data: event.data.object as JsonValue,
  apiVersion: event.apiVersion,
  livemode: event.livemode,
  pendingWebhooks: event.pendingWebhooks,
  processedAt: new Date(),
}
```

Also: use `stripeEvent.stripeEventId` as unique key correctly in `where`.

### 5. Add plan-gated agent creation limit

Before creating a new agent (not just publishing), check `agents` metric against plan limit. Warn at 80% capacity.

## Out of Scope

- Frontend billing UI (apps/web) — separate effort
- Invoice adjustment / admin credits
- Proration handling
- E164 phone normalization in compliance

## Files to Modify

- `apps/api/src/calls/calls.service.ts` — add usage metering on call end
- `apps/api/src/billing/billing.service.ts` — add outbound call limit check, trial guard
- `apps/api/src/webhooks/stripe-webhook.service.ts` — fix markProcessed, store event metadata
- `apps/api/src/agents/agents.service.ts` — agent creation plan limit check