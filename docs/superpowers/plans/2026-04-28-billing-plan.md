# Phase 9: Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stripe-powered subscription billing (Starter/Pro/Agency plans) + per-call usage metering. Org-level subscriptions, workspace-level feature gates.

**Architecture:** Stripe Checkout (hosted page) for subscription creation. Stripe webhooks for lifecycle events. Usage metering via `UsageRecord` rows written after each call ends. Feature gates check org plan + tier limits at API level. No Stripe Elements — fully hosted.

**Tech Stack:** `stripe` npm package, Prisma, NestJS, Zod (shared schemas)

---

## File Map

```
apps/api/prisma/schema.prisma               — add Subscription + UsageRecord models
packages/shared/src/schemas/                 — create billing.ts (Plan, Subscription, Usage DTOs)
packages/shared/src/index.ts                — export billing schemas
apps/api/src/billing/                       — NEW module (service, controller, module)
apps/api/src/billing/billing.module.ts
apps/api/src/billing/billing.service.ts
apps/api/src/billing/billing.controller.ts
apps/api/src/billing/billing.service.test.ts
apps/api/src/webhooks/                      — create stripe-webhook.controller.ts + module
apps/api/src/webhooks/stripe-webhook.module.ts
apps/api/src/app.module.ts                  — add BillingModule + StripeWebhookModule
apps/api/src/agents/agents.module.ts        — inject BillingModule for feature gates
apps/api/src/calls/calls.service.ts         — inject UsageService, record after call ends
apps/web/lib/stripe.ts                      — create Stripe server client
apps/web/app/dashboard/billing/             — billing page (plan selector + usage)
apps/web/components/billing-panel.tsx       — plan cards + current plan badge + upgrade
.env.example                                 — add STRIPE_SECRET_KEY + price IDs
docs/superpowers/plans/YYYY-MM-DD-billing-plan.md  — this file
```

---

## Task 1: Add Prisma Billing Models

**Files:**
- Modify: `apps/api/prisma/schema.prisma:559` (end of file)

Add after `model ClientInvite`:

```prisma
// --------------------------------------------------------------------------
// Billing (Phase 9)
// --------------------------------------------------------------------------

model Subscription {
  id                    String   @id @default(uuid()) @db.Uuid
  organizationId        String   @unique @map("organization_id") @db.Uuid
  stripeCustomerId      String   @unique @map("stripe_customer_id")
  stripeSubscriptionId  String?  @unique @map("stripe_subscription_id")
  stripePriceId         String?  @map("stripe_price_id")
  plan                  String   @default("free") // free | starter | pro | agency
  status                String   @default("trialing") // trialing | active | past_due | canceled | unpaid
  currentPeriodStart    DateTime @map("current_period_start")
  currentPeriodEnd      DateTime @map("current_period_end")
  cancelAtPeriodEnd     Boolean  @default(false) @map("cancel_at_period_end")
  createdAt             DateTime @default(now()) @map("created_at")
  updatedAt             DateTime @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("subscriptions")
}

model UsageRecord {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @map("organization_id") @db.Uuid
  workspaceId    String   @map("workspace_id") @db.Uuid
  callId         String?  @map("call_id") @db.Uuid
  usageType      String   @map("usage_type") // voice_minutes | agents_published | seats
  quantity       Float    // e.g. 3.4 minutes
  unit           String   @default("minute")
  costCents      Int      @map("cost_cents") // cents VoiceForge charges; 0 for included
  periodStart    DateTime @map("period_start") // billing period start (month start)
  periodEnd      DateTime @map("period_end")   // billing period end
  recordedAt     DateTime @default(now()) @map("recorded_at")

  organization Organization @relation(fields: [organizationId], references: [id])
  workspace    Workspace    @relation(fields: [workspaceId], references: [id])
  call         Call?       @relation(fields: [callId], references: [id], onDelete: SetNull)

  @@index([organizationId, periodStart])
  @@index([workspaceId, periodStart])
  @@map("usage_records")
}
```

Also add relation on `Organization`:
```prisma
model Organization {
  // ... existing fields ...
  subscription Subscription?
  // ...
}
```

---

## Task 2: Create Shared Billing Schemas

**Files:**
- Create: `packages/shared/src/schemas/billing.ts`
- Modify: `packages/shared/src/index.ts`

```typescript
import { z } from 'zod';

// Plan constants (match Stripe Price IDs in env)
export const PLAN_LIMITS = {
  free:    { agents: 1, voiceMinutes: 0,  seats: 1, outbound: false, whiteLabel: false, analytics: false },
  starter: { agents: 1, voiceMinutes: 100, seats: 3, outbound: false, whiteLabel: false, analytics: true  },
  pro:     { agents: 5, voiceMinutes: 500, seats: 10, outbound: true, whiteLabel: false, analytics: true  },
  agency:  { agents: -1, voiceMinutes: -1, seats: -1, outbound: true, whiteLabel: true, analytics: true  },
} as const;

export type PlanName = keyof typeof PLAN_LIMITS;

export const PlanSchema = z.enum(['free', 'starter', 'pro', 'agency']);
export type Plan = z.infer<typeof PlanSchema>;

export const SubscriptionStatusSchema = z.enum(['trialing', 'active', 'past_due', 'canceled', 'unpaid']);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const UsageTypeSchema = z.enum(['voice_minutes', 'agents_published', 'seats', 'storage_gb']);
export type UsageType = z.infer<typeof UsageTypeSchema>;

// DTOs
export const CreateCheckoutSessionDtoSchema = z.object({
  price_id: z.string().startsWith('price_'),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});
export type CreateCheckoutSessionDto = z.infer<typeof CreateCheckoutSessionDtoSchema>;

export const CreatePortalSessionDtoSchema = z.object({
  return_url: z.string().url(),
});
export type CreatePortalSessionDto = z.infer<typeof CreatePortalSessionDtoSchema>;

export const SubscriptionDtoSchema = z.object({
  id: z.string().uuid(),
  plan: PlanSchema,
  status: SubscriptionStatusSchema,
  current_period_start: z.string().datetime(),
  current_period_end: z.string().datetime(),
  cancel_at_period_end: z.boolean(),
  stripe_customer_id: z.string(),
  stripe_subscription_id: z.string().uuid().nullable(),
});
export type SubscriptionDto = z.infer<typeof SubscriptionDtoSchema>;

export const UsageRecordDtoSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  call_id: z.string().uuid().nullable(),
  usage_type: UsageTypeSchema,
  quantity: z.number(),
  unit: z.string(),
  cost_cents: z.number().int(),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
  recorded_at: z.string().datetime(),
});
export type UsageRecordDto = z.infer<typeof UsageRecordDtoSchema>;

export const WorkspaceUsageDtoSchema = z.object({
  workspace_id: z.string().uuid(),
  plan: PlanSchema,
  usage: z.object({
    voice_minutes_used: z.number(),
    voice_minutes_limit: z.number().int(),
    agents_used: z.number().int(),
    agents_limit: z.number().int(),
    overage_cents: z.number().int(),
  }),
});
export type WorkspaceUsageDto = z.infer<typeof WorkspaceUsageDtoSchema>;

// Webhook event payload shapes (subset of Stripe events we handle)
export const StripeEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number(),
  data: z.object({
    object: z.unknown(),
  }),
});
export type StripeEvent = z.infer<typeof StripeEventSchema>;
```

Modify `packages/shared/src/index.ts` to add:
```typescript
export * from './schemas/billing';
```

---

## Task 3: Create BillingModule (Service + Controller)

**Files:**
- Create: `apps/api/src/billing/billing.module.ts`
- Create: `apps/api/src/billing/billing.service.ts`
- Create: `apps/api/src/billing/billing.controller.ts`

### `billing.module.ts`
```typescript
import { Module, forwardRef } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { Stripe } from 'stripe';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    {
      provide: Stripe,
      useFactory: (config: ConfigService) =>
        new Stripe(config.get('STRIPE_SECRET_KEY', ''), { apiVersion: '2025-02-24.acacia' }),
      inject: [ConfigService],
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}
```

### `billing.service.ts`

Core methods:
- `getOrCreateCustomer(orgId, email)` — if org has `stripeCustomerId`, return it; else create Stripe Customer, store in `Subscription.stripeCustomerId`
- `createCheckoutSession(orgId, priceId, successUrl, cancelUrl)` — calls Stripe checkout.sessions.create with customer + price + metadata `{ orgId }`
- `createPortalSession(orgId, returnUrl)` — calls Stripe billing_portal.sessions.create
- `getSubscription(orgId)` — fetch from DB, return `SubscriptionDto` or null
- `getWorkspaceUsage(workspaceId)` — aggregate `UsageRecord` for current billing period, compare to plan limits, return `WorkspaceUsageDto`
- `checkFeatureGate(orgId, feature)` — check plan limits; throw `403 Forbidden` with `PLAN_LIMIT_EXCEEDED` code if exceeded

Feature gate logic:
```typescript
canPublishAgent(orgId: string): boolean
canOutboundCall(orgId: string): boolean
canWhiteLabel(orgId: string): boolean
enforceAgentLimit(orgId: string): void  // throws if at limit
```

Helper: `getOrgFromWorkspace(workspaceId)` — join Workspace → Organization → Subscription.

### `billing.controller.ts`

Routes (all behind `WorkspaceGuard`):

```
POST /workspaces/:ws/billing/checkout
  Body: { price_id, success_url, cancel_url }
  Returns: { checkout_url }

POST /workspaces/:ws/billing/portal
  Body: { return_url }
  Returns: { portal_url }

GET /workspaces/:ws/billing/subscription
  Returns: SubscriptionDto | null

GET /workspaces/:ws/billing/usage
  Returns: WorkspaceUsageDto
```

---

## Task 4: Create Stripe Webhook Handler

**Files:**
- Create: `apps/api/src/webhooks/stripe-webhook.module.ts`
- Create: `apps/api/src/webhooks/stripe-webhook.controller.ts`
- Modify: `apps/api/src/app.module.ts`

### `stripe-webhook.module.ts`
```typescript
import { Module } from '@nestjs/common';
import { StripeWebhookController } from './stripe-webhook.controller';
import { BillingService } from '../billing/billing.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { Stripe } from 'stripe';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [StripeWebhookController],
  providers: [
    BillingService,
    {
      provide: Stripe,
      useFactory: (config: ConfigService) =>
        new Stripe(config.get('STRIPE_SECRET_KEY', ''), { apiVersion: '2025-02-24.acacia' }),
      inject: [ConfigService],
    },
  ],
})
export class StripeWebhookModule {}
```

### `stripe-webhook.controller.ts`

`POST /webhooks/stripe` — raw body, signature in `stripe-signature` header.

Signature verification:
```typescript
const sig = req.headers['stripe-signature'];
const event = stripe.webhooks.constructEvent(
  rawBody,
  sig,
  config.get('STRIPE_WEBHOOK_SECRET'),
);
```

Handle events:
- `checkout.session.completed` — upsert subscription, set `stripeSubscriptionId` + `stripePriceId`, set status `active`
- `customer.subscription.updated` — update plan, status, period dates
- `customer.subscription.deleted` — set status `canceled`
- `invoice.paid` — extend period, set status `active`
- `invoice.payment_failed` — set status `past_due`

Idempotency: use `event.id` as idempotency key in a Prisma transaction:
```typescript
await prisma.$transaction(async (tx) => {
  const existing = await tx.stripeEvent.findUnique({ where: { eventId: event.id } });
  if (existing) return; // already processed
  await tx.stripeEvent.create({ data: { eventId: event.id, eventType: event.type } });
  // then process event...
});
```

Create `StripeEvent` model in schema:
```prisma
model StripeEvent {
  id        String   @id @default(uuid()) @db.Uuid
  eventId   String   @unique @map("event_id")
  eventType String   @map("event_type")
  processedAt DateTime @default(now()) @map("processed_at")

  @@map("stripe_events")
}
```

---

## Task 5: Wire Usage Metering into CallsService

**Files:**
- Modify: `apps/api/src/calls/calls.service.ts` (inject BillingService)
- Modify: `apps/api/src/calls/calls.module.ts` (import BillingModule)

After a call ends (`status` set to `completed` or `failed`), in the same transaction or immediately after:

```typescript
// In calls.service.ts
import { BillingService } from '../billing/billing.service';

async recordUsage(callId: string, workspaceId: string, orgId: string) {
  const call = await this.prisma.call.findUnique({ where: { id: callId } });
  if (!call?.durationSeconds) return;

  const minutes = Math.ceil(call.durationSeconds / 60);
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  await this.prisma.usageRecord.create({
    data: {
      organizationId: orgId,
      workspaceId,
      callId,
      usageType: 'voice_minutes',
      quantity: minutes,
      unit: 'minute',
      costCents: 0, // included in plan; overage calculated on read
      periodStart,
      periodEnd,
    },
  });
}
```

Call this at end of `endTestSession`, after `CallsService.endCall`, and in webhook `ingestEvent` when `call.ended`.

---

## Task 6: Add Feature Gates to Agent Operations

**Files:**
- Modify: `apps/api/src/agents/agents.service.ts` (inject BillingService)
- Modify: `apps/api/src/agents/agents.module.ts` (import BillingModule)

In `publishAgent`:
```typescript
await this.billing.enforceAgentLimit(orgId);
// if over limit, throw PAYMENT_REQUIRED with upgrade prompt
```

In `startOutboundCall` (already exists in CallsService):
```typescript
await this.billing.checkFeatureGate(orgId, 'outbound');
// if not allowed, throw PLAN_LIMIT_EXCEEDED
```

---

## Task 7: Build Billing Frontend Page

**Files:**
- Create: `apps/web/app/dashboard/billing/page.tsx`
- Create: `apps/web/components/billing-panel.tsx`
- Create: `apps/web/lib/stripe.ts`
- Modify: `apps/web/app/dashboard/layout.tsx` (add billing nav item)

### `apps/web/lib/stripe.ts`
```typescript
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export function getStripeServer() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-02-24.acacia',
  });
}

export async function getOrCreateCustomer(orgId: string, email: string): Promise<string> {
  const stripe = getStripeServer();
  // Call API endpoint to handle server-side Stripe operation
  const res = await fetch(`/api/billing/customer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId, email }),
  });
  return (await res.json()).customerId;
}
```

### `billing/page.tsx`
Route: `/dashboard/billing`. Shows:
- Current plan badge + status
- Usage meters (voice minutes, agents)
- Plan comparison cards (3 tiers)
- "Upgrade" button → calls `POST /api/billing/checkout` → redirect to Stripe
- "Manage billing" → calls `POST /api/billing/portal` → redirect to Stripe Portal

### `billing-panel.tsx`
Plan cards with feature lists. Highlight current plan. Upgrade button per card.

---

## Task 8: Add API Routes for Billing (Next.js)

**Files:**
- Create: `apps/web/app/api/billing/checkout/route.ts`
- Create: `apps/web/app/api/billing/portal/route.ts`
- Create: `apps/web/app/api/billing/subscription/route.ts`
- Create: `apps/web/app/api/billing/usage/route.ts`

Each proxies to NestJS backend with Clerk session token.

---

## Task 9: Write Billing Tests

**Files:**
- Create: `apps/api/src/billing/billing.service.test.ts`

Test cases:
1. `getSubscription` returns null for free org
2. `getSubscription` returns SubscriptionDto for org with subscription
3. `createCheckoutSession` creates Stripe session with correct params + metadata
4. `getWorkspaceUsage` aggregates current period records + shows limit
5. `checkFeatureGate` throws `PLAN_LIMIT_EXCEEDED` when outbound not allowed
6. `enforceAgentLimit` throws when at agent count limit
7. `canPublishAgent` / `canOutboundCall` / `canWhiteLabel` correct per plan

Stripe webhook tests:
1. `checkout.session.completed` → creates/updates Subscription with `stripeSubscriptionId`
2. `customer.subscription.updated` → updates plan + status
3. `customer.subscription.deleted` → sets status `canceled`
4. `invoice.payment_failed` → sets `past_due`
5. Idempotency — second delivery of same event is no-op

---

## Task 10: Update Env + Documentation

**Files:**
- Modify: `.env.example` — add:
  ```
  STRIPE_SECRET_KEY=sk_test_...
  STRIPE_WEBHOOK_SECRET=whsec_...
  STRIPE_STARTER_PRICE_ID=price_...
  STRIPE_PRO_PRICE_ID=price_...
  STRIPE_AGENCY_PRICE_ID=price_...
  ```
- Modify: `docs/16_BILLING.md` — mark as implemented, add Stripe event table, usage record schema

---

## Verification

After all tasks:
1. `npm run typecheck -w @voiceforge/api -w @voiceforge/shared -w @voiceforge/web` — all clean
2. `npm run test -w @voiceforge/api` — billing tests pass
3. `npm run db:generate -w @voiceforge/api` — Prisma generates new models
4. No placeholder comments, no TBD/TODO in billing code
5. Stripe webhook routes respond with 400 on invalid signature (security)