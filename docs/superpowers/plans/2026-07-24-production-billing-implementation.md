# Production Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build production-safe organization billing that collects subscription or prepaid revenue before admitting paid calls, limits VoiceForge to 100 concurrent calls, and gives Free organizations exactly one three-minute browser test.

**Architecture:** A versioned shared catalog drives pricing and entitlements. PostgreSQL stores subscriptions, immutable credit ledger entries, credit buckets, call usage, trial redemptions, provider deployments, and provider costs; Redis provides atomic short-lived concurrency leases only. Stripe webhooks grant credits, a call-admission service coordinates compliance-complete dispatches, and signed LiveKit runtime events meter connected minutes.

**Tech Stack:** TypeScript strict mode, Zod, NestJS, Prisma/PostgreSQL, Redis/ioredis, Stripe Checkout and webhooks, Next.js, LiveKit Agents, Vitest.

## Global Constraints

- Agent Spec JSON remains the central agent contract.
- Every persistent customer record and query is scoped by `organizationId`; workspace scope is additional, never a replacement.
- No outbound provider dispatch occurs before compliance succeeds.
- Free permits one lifetime browser test capped at 180 seconds; Free permits no PSTN call, phone number, or campaign.
- Vapi is the primary Free browser-test provider and Retell is fallback within the same redemption.
- Paid PSTN calls use customer-owned Twilio or VoBiz through LiveKit SIP and OpenAI GPT Realtime.
- VoiceForge pays OpenAI and LiveKit; customers pay Twilio or VoBiz directly.
- Starter is `$99/month`, includes 200 minutes, 3 agents, 1 workspace, 2 Nango connections, and 2 concurrent calls.
- Growth is `$299/month`, includes 1,000 minutes, 10 agents, 5 workspaces, 10 Nango connections, and 10 concurrent calls.
- Enterprise starts at `$999/month`, includes 3,000 minutes, 30 agents, 15 workspaces, 25 Nango connections, and 25 concurrent calls by default; the contractual ceiling is 50.
- Extra usage is prepaid only: `$39` grants 100 minutes. No unpaid overage, negative balance, or unlimited tier is allowed.
- Included credits expire at the billing-period end; purchased credits are consumed second and expire 12 months after purchase.
- Customer-visible usage bills each started connected minute; unanswered calls consume zero VoiceForge minutes.
- New calls require 60 available seconds and a concurrency lease.
- Platform concurrency is 100 connecting or connected calls across all organizations.
- PostgreSQL is the source of truth. Redis failure blocks new outbound and campaign dispatches.
- All inputs use Zod validation, critical mutations use idempotency keys, and every critical decision creates an audit log.
- Stripe Tax defaults off and can be enabled only by explicit configuration after registrations are confirmed.
- Pin the stable Stripe package to `22.3.2`; use `Stripe.LATEST_API_VERSION` rather than a duplicated API-version string.
- Billing enforcement defaults to `enforce`; `halt` blocks every new paid call, and shadow decisions are allowed only for explicitly listed internal organization IDs.
- Run implementation in an isolated Git worktree because the current workspace contains unrelated staged changes.

---

## File Structure

### Shared contract

- `packages/shared/src/billing/catalog.ts` — versioned commercial catalog and typed entitlements.
- `packages/shared/src/schemas/billing.ts` — request, response, ledger, admission, runtime-event, and reason-code schemas.
- `packages/shared/src/billing/catalog.test.ts` — exact price and entitlement invariants.
- `packages/shared/src/schemas/billing.test.ts` — Zod boundary tests.

### Persistence and billing domain

- `apps/api/prisma/schema.prisma` — durable billing, trial, provider-deployment, call-usage, and provider-cost models.
- `apps/api/prisma/migrations/20260724090000_production_billing/migration.sql` — additive schema, safe backfill, indexes, and constraints.
- `apps/api/src/billing/credit-ledger.service.ts` — transactional grants, reservations, debits, releases, expirations, and reversals.
- `apps/api/src/billing/credit-ledger.service.test.ts` — arithmetic, idempotency, bucket ordering, and concurrent-balance tests.
- `apps/api/src/billing/entitlement.service.ts` — effective plan and stable organization entitlement decisions.
- `apps/api/src/billing/entitlement.service.test.ts` — status and quota decisions.
- `apps/api/src/billing/call-concurrency.service.ts` — Redis global and organization leases.
- `apps/api/src/billing/call-concurrency.service.test.ts` — 100th/101st slot, renew, release, and Redis-failure tests.
- `apps/api/src/billing/call-concurrency.integration.test.ts` — real-Redis 101-request capacity test.
- `apps/api/src/billing/call-admission.service.ts` — paid-call admission and dispatch-failure compensation.
- `apps/api/src/billing/call-admission.service.test.ts` — ordering, reservation, lease, denial, and cleanup tests.
- `apps/api/src/billing/trial.service.ts` — one lifetime Vapi/Retell browser-test redemption.
- `apps/api/src/billing/trial.service.test.ts` — lifetime uniqueness and same-redemption fallback tests.
- `apps/api/src/workers/trial-timeout.worker.ts` — durable provider termination at the 180-second limit.
- `apps/api/src/workers/trial-timeout.worker.test.ts` — retry-safe test-call termination.
- `apps/api/src/billing/runtime-usage.service.ts` — signed call connection, heartbeat, and finalization events.
- `apps/api/src/billing/runtime-usage.service.test.ts` — duplicate/out-of-order events, rounding, low-balance, and finalization tests.
- `apps/api/src/billing/provider-cost.service.ts` — actual or estimated OpenAI/LiveKit cost records.
- `apps/api/src/billing/provider-cost.service.test.ts` — estimate and reconciliation tests.
- `apps/api/src/billing/reconciliation.service.ts` — ledger projection, stale-call, lease, and provider-cost repair.
- `apps/api/src/billing/reconciliation.service.test.ts` — correction and audit tests.

### Stripe and HTTP

- `apps/api/src/billing/billing.service.ts` — Stripe customer, subscription Checkout, pack Checkout, Portal, dashboard reads.
- `apps/api/src/billing/billing.service.test.ts` — server-owned price, tax, Checkout, and Portal tests.
- `apps/api/src/billing/billing.controller.ts` — organization-scoped dashboard and Checkout endpoints.
- `apps/api/src/billing/runtime-usage.controller.ts` — HMAC-authenticated internal runtime events.
- `apps/api/src/billing/runtime-usage.controller.test.ts` — signature, timestamp, replay, and validation tests.
- `apps/api/src/billing/billing.module.ts` — billing-domain dependency graph.
- `apps/api/src/webhooks/stripe-webhook.service.ts` — subscription sync, invoice grants, pack grants, reversals, and cache invalidation.
- `apps/api/src/webhooks/stripe-webhook.service.test.ts` — duplicate, reordered, grant, refund, and dispute cases.

### Call integration

- `apps/api/src/calls/calls.service.ts` — browser-test routing and removal of generic paid Vapi/Retell outbound.
- `apps/api/src/calls/start-test-session.test.ts` — one-time trial and fallback behavior.
- `apps/api/src/calls/start-outbound-idempotency.test.ts` — paid PSTN route rejection without BYO telephony.
- `apps/api/src/telephony/telephony.service.ts` — compliance-complete admission before LiveKit dispatch, inbound admission, and terminal usage events.
- `apps/api/src/telephony/telephony.service.test.ts` — no-dispatch denial, no-answer release, inbound denial, and call-ID metadata.
- `apps/api/src/outbound-campaign/workers/outbound-call.worker.ts` — disallow Vapi/Retell fallback for paid campaigns.
- `apps/api/src/outbound-campaign/workers/outbound-call.worker.test.ts` — missing BYO number fails without provider dispatch.
- `apps/api/src/voice/voice-provider.registry.ts` — explicit browser-test provider sequence.
- `apps/api/src/voice/voice-provider.registry.test.ts` — Vapi-first, Retell-second sequence.
- `apps/livekit-agent/src/billing-runtime-client.ts` — signed runtime event client.
- `apps/livekit-agent/src/billing-runtime-client.test.ts` — HMAC and response handling.
- `apps/livekit-agent/src/index.ts` — connect, heartbeat, final warning, shutdown, and finalization hooks.
- `apps/livekit-agent/src/agent-runtime.ts` — call-context resolution schema.
- `apps/livekit-agent/src/agent-runtime.test.ts` — dispatch and room context tests.

### Existing quota boundaries and UI

- `apps/api/src/agents/agents.service.ts` — organization agent entitlement checks.
- `apps/api/src/agents/agents.service.test.ts` — agent-count denial.
- `apps/api/src/white-label/white-label.service.ts` — organization workspace entitlement checks.
- `apps/api/src/white-label/white-label.test.ts` — child-workspace denial.
- `apps/api/src/workspace-crm/workspace-crm.service.ts` — current connection quota until Nango replaces direct credentials.
- `apps/api/src/workspace-crm/workspace-crm.service.test.ts` — connection-count denial.
- `apps/api/src/calendar/calendar.service.ts` — current connection quota for Google Calendar.
- `apps/api/src/calendar/calendar.service.test.ts` — connection-count denial.
- `apps/web/components/pricing-page.tsx` — exact launch prices, limits, and usage rules.
- `apps/web/components/billing-panel.tsx` — balance buckets, pack purchase, subscription state, and block reasons.
- `apps/web/lib/pricing-estimator.ts` — estimator driven by the shared catalog.
- `apps/web/lib/pricing-estimator.test.ts` — recommendation and prepaid-pack math.
- `apps/web/app/pricing/page.tsx` — pricing-page server configuration without demo billing.
- `apps/web/app/api/billing/checkout/route.ts` — subscription Checkout proxy.
- `apps/web/app/api/billing/topup/route.ts` — pack Checkout proxy.
- `apps/web/lib/billing-mode.ts` and `apps/web/lib/billing-mode.test.ts` — obsolete demo-billing helpers removed after Checkout is production controlled.

### Operations

- `apps/api/src/config/env.ts` — Stripe tax, pack price, runtime HMAC, cost reserve, and concurrency configuration.
- `.env.example` — documented production billing variables.
- `apps/api/src/common/metrics.service.ts` — billing, capacity, and margin metrics.
- `apps/api/src/workers/billing-reconciliation.worker.ts` — scheduled BullMQ reconciliation.
- `apps/api/src/workers/workers.module.ts` — reconciliation worker registration.
- `apps/api/package.json` and `pnpm-lock.yaml` — Stripe `22.3.2`.
- `docs/operations/billing-runbook.md` — Stripe setup, rollback, reconciliation, and incident procedures.

---

### Task 1: Replace the Demo Catalog With the Approved Commercial Contract

**Files:**
- Modify: `packages/shared/src/billing/catalog.ts`
- Modify: `packages/shared/src/schemas/billing.ts`
- Modify: `packages/shared/src/billing/catalog.test.ts`
- Modify: `packages/shared/src/schemas/billing.test.ts`
- Verify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `BILLING_CATALOG_VERSION`, `PLAN_CATALOG`, `PLAN_LIMITS`, `getPlanEntitlements(plan)`.
- Produces: `EntitlementDecision`, `CreditBalanceDto`, `CreateTopUpCheckoutDto`, `RuntimeUsageEvent`, and `RuntimeUsageDecision`.
- Consumes: no implementation-task output.

- [ ] **Step 1: Write failing catalog tests**

```ts
it('matches the approved launch prices and quotas', () => {
  expect(BILLING_CATALOG_VERSION).toBe('2026-07-24');
  expect(getPlanById('free')).toMatchObject({ monthlyPriceUsd: 0 });
  expect(getPlanById('starter')).toMatchObject({ monthlyPriceUsd: 99 });
  expect(getPlanById('growth')).toMatchObject({ monthlyPriceUsd: 299 });
  expect(getPlanById('enterprise')).toMatchObject({ monthlyPriceUsd: 999 });

  expect(getPlanEntitlements('free')).toMatchObject({
    includedMinutes: 0,
    lifetimeBrowserTestSeconds: 180,
    outboundPstn: false,
    concurrentCalls: 0,
  });
  expect(getPlanEntitlements('starter')).toMatchObject({
    includedMinutes: 200,
    agents: 3,
    workspaces: 1,
    nangoConnections: 2,
    concurrentCalls: 2,
  });
  expect(getPlanEntitlements('growth')).toMatchObject({
    includedMinutes: 1000,
    agents: 10,
    workspaces: 5,
    nangoConnections: 10,
    concurrentCalls: 10,
    whiteLabel: true,
  });
  expect(getPlanEntitlements('enterprise')).toMatchObject({
    includedMinutes: 3000,
    agents: 30,
    workspaces: 15,
    nangoConnections: 25,
    concurrentCalls: 25,
    maximumContractConcurrentCalls: 50,
  });
  expect(MINUTE_PACK).toEqual({ minutes: 100, priceUsd: 39, expiresAfterDays: 365 });
});
```

- [ ] **Step 2: Run the shared tests and confirm the old catalog fails**

Run:

```powershell
pnpm --filter @voiceforge/shared exec vitest run src/billing/catalog.test.ts src/schemas/billing.test.ts
```

Expected: failure showing the old `$49`, `$149`, free monthly minutes, or unlimited Enterprise values.

- [ ] **Step 3: Implement one typed catalog**

Use this entitlement shape:

```ts
export interface PlanEntitlements {
  includedMinutes: number;
  lifetimeBrowserTestSeconds: number;
  agents: number;
  workspaces: number;
  nangoConnections: number;
  concurrentCalls: number;
  maximumContractConcurrentCalls: number;
  contacts: number;
  outboundPstn: boolean;
  campaigns: boolean;
  whiteLabel: boolean;
}

export const BILLING_CATALOG_VERSION = '2026-07-24' as const;
export const MINUTE_PACK = {
  minutes: 100,
  priceUsd: 39,
  expiresAfterDays: 365,
} as const;
```

Make `CheckoutPlanSchema` accept only `starter` and `growth`; Enterprise is sales-assisted. Set Free PSTN minutes and outbound calls to zero. Preserve compatibility aliases only where an existing caller still compiles, and derive those aliases from the new entitlement object.

Remove `BillingModeSchema`. Runtime safety is represented by explicit Checkout configuration plus `BILLING_ENFORCEMENT_MODE`; a recurring Free allowance must not survive under a “demo” label.

- [ ] **Step 4: Add strict DTO and reason-code schemas**

Define stable denial codes:

```ts
export const EntitlementReasonSchema = z.enum([
  'allowed',
  'subscription_required',
  'subscription_inactive',
  'trial_already_used',
  'credit_insufficient',
  'agent_limit_reached',
  'workspace_limit_reached',
  'integration_limit_reached',
  'organization_concurrency_reached',
  'platform_concurrency_reached',
  'billing_temporarily_unavailable',
]);

export const CreateTopUpCheckoutDtoSchema = z.object({
  successPath: RelativeBillingPathSchema.default('/dashboard/billing?topup=success'),
  cancelPath: RelativeBillingPathSchema.default('/dashboard/billing?topup=cancel'),
}).strict();
```

Define runtime events as a discriminated union over `call_connected`, `minute_boundary`, `call_ended`, and `call_failed`. Require `eventId`, `callId`, `organizationId`, `occurredAt`, and event-specific fields.

Add `paused` to `SubscriptionStatusSchema` so every Stripe state in the admission policy is representable.

- [ ] **Step 5: Run shared tests and typecheck**

Run:

```powershell
pnpm --filter @voiceforge/shared exec vitest run src/billing/catalog.test.ts src/schemas/billing.test.ts
pnpm --filter @voiceforge/shared exec tsc -p tsconfig.json --noEmit
```

Expected: both commands exit `0`.

- [ ] **Step 6: Commit the shared contract**

```powershell
git add packages/shared/src/billing/catalog.ts packages/shared/src/schemas/billing.ts packages/shared/src/billing/catalog.test.ts packages/shared/src/schemas/billing.test.ts packages/shared/src/index.ts
git commit -m "feat(billing): define production catalog and contracts"
```

---

### Task 2: Add Durable Billing, Trial, Usage, and Provider-Cost Models

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260724090000_production_billing/migration.sql`

**Interfaces:**
- Consumes: catalog version and plan keys from Task 1.
- Produces: Prisma models used by all remaining backend tasks.

- [ ] **Step 1: Add Prisma models and relations**

Create these models with UUID identifiers, mapped snake-case columns, timestamps, foreign keys, and indexes:

```prisma
model BillingCreditBucket {
  id               String   @id @default(uuid()) @db.Uuid
  organizationId   String   @map("organization_id") @db.Uuid
  sourceType       String   @map("source_type")
  sourceId         String   @map("source_id")
  originalSeconds  Int      @map("original_seconds")
  remainingSeconds Int      @map("remaining_seconds")
  validFrom        DateTime @map("valid_from")
  expiresAt        DateTime @map("expires_at")
  priority         Int
  status           String   @default("active")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  ledgerEntries BillingLedgerEntry[]

  @@unique([organizationId, sourceType, sourceId])
  @@index([organizationId, status, expiresAt, priority])
  @@map("billing_credit_buckets")
}
```

Add:

- `BillingLedgerEntry` with unique `[organizationId, idempotencyKey]`, signed `seconds`, `balanceAfterSeconds`, optional bucket/workspace/call, actor fields, reason code, and JSON metadata.
- `OrganizationCreditBalance` with unique `organizationId`, `availableSeconds`, `reservedSeconds`, `status`, `reviewReason`, and integer `version`.
- `CallUsage` with unique `callId`, connected timestamps, raw/billable/reserved/debited seconds, finalization state, and finalization idempotency key.
- `RuntimeUsageEvent` with unique `[organizationId, eventId]`, call, event type, occurred timestamp, validated payload, stored decision, and processed timestamp.
- `TrialRedemption` with unique `organizationId`, initiating user, provider-attempt JSON, selected provider, session IDs, 180-second cap, timestamps, and disposition.
- `AgentProviderDeployment` with unique `[agentVersionId, provider]` so Vapi and Retell runtime IDs cannot overwrite each other.
- `ProviderCostEvent` with unique `[provider, idempotencyKey]`, service category, measured unit, quantity as `Decimal`, currency, amount as `Decimal`, estimate flag/version, and reconciliation timestamp.
- `CallConcurrencyLease` as a PostgreSQL recovery record with unique `callId`, organization, lease token, state, and expiry.
- Subscription fields `stripeProductId`, `catalogVersion`, and `webhookUpdatedAt`.
- Subscription field `concurrentCallLimitOverride` for sales-configured Enterprise limits, constrained to `1..50` and ignored on other plans.
- StripeEvent fields `processingStartedAt` and `attemptCount` so a crashed webhook claim can be reclaimed after its processing lease expires.
- Required relations on `Organization`, `Workspace`, `Call`, and `AgentVersion`.

- [ ] **Step 2: Write a safe additive migration**

The SQL must:

1. create the new tables and indexes;
2. backfill `subscriptions.catalog_version` with `'legacy'`;
3. backfill `calls.organization_id` from `workspaces.organization_id`;
4. abort with an explicit exception if any call still has a null organization;
5. make `calls.organization_id` non-null;
6. preserve `usage_records` during shadow metering;
7. add database checks that seconds and monetary amounts cannot be negative where the field is not signed;
8. add a check that bucket remaining seconds never exceed original seconds.

Use this migration guard:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM calls WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'production billing migration cannot continue: calls.organization_id contains null rows';
  END IF;
END $$;
```

- [ ] **Step 3: Validate and generate Prisma**

Run:

```powershell
pnpm --filter @voiceforge/api exec prisma format
pnpm --filter @voiceforge/api exec prisma validate
pnpm db:generate
```

Expected: all commands exit `0`.

- [ ] **Step 4: Inspect the SQL before applying it**

Run:

```powershell
rg -n "DROP TABLE|DROP COLUMN|CASCADE|billing_credit_buckets|billing_ledger_entries|trial_redemptions|provider_cost_events" apps/api/prisma/migrations/20260724090000_production_billing/migration.sql
```

Expected: no destructive drop statement; `CASCADE` appears only in foreign-key delete behavior intentionally defined by the schema.

- [ ] **Step 5: Commit the persistence layer**

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260724090000_production_billing/migration.sql
git commit -m "feat(billing): add credit ledger and usage persistence"
```

---

### Task 3: Implement the Transactional Credit Ledger

**Files:**
- Create: `apps/api/src/billing/credit-ledger.service.ts`
- Create: `apps/api/src/billing/credit-ledger.service.test.ts`
- Modify: `apps/api/src/billing/billing.module.ts`

**Interfaces:**
- Consumes: Prisma billing models from Task 2.
- Produces:

```ts
grantSubscriptionCredits(input: SubscriptionGrantInput): Promise<CreditBalance>
grantPurchasedCredits(input: PurchasedGrantInput): Promise<CreditBalance>
reserveInitialMinute(input: MinuteReservationInput): Promise<MinuteReservation>
commitReservation(input: CommitReservationInput): Promise<CreditBalance>
reserveAndDebitNextMinute(input: NextMinuteInput): Promise<RuntimeUsageDecision>
releaseReservation(input: ReleaseReservationInput): Promise<CreditBalance>
reversePurchasedCredits(input: CreditReversalInput): Promise<CreditBalance>
getBalance(organizationId: string): Promise<CreditBalance>
```

- [ ] **Step 1: Write failing ledger tests**

Cover:

```ts
it('grants one invoice exactly once');
it('consumes included buckets before purchased buckets');
it('reserves 60 seconds without changing total owned credit');
it('commits a reservation exactly once on connection');
it('releases the full reservation when a call never connects');
it('refuses a reservation when only 59 seconds are available');
it('never allows two concurrent reservations to overspend one balance');
it('removes unused purchased credit on a refund');
it('blocks the organization for manual review when refunded credit was consumed');
```

For the concurrency test, make both promises execute against the same mocked transaction lock and assert one succeeds and one returns `credit_insufficient`.

- [ ] **Step 2: Run the ledger tests and confirm failure**

Run:

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/credit-ledger.service.test.ts
```

Expected: failure because `CreditLedgerService` does not exist.

- [ ] **Step 3: Implement transactional grants and balance projection**

Use `prisma.$transaction` and lock the projection row before modifying buckets:

```ts
await tx.$queryRaw`
  SELECT id
  FROM organization_credit_balances
  WHERE organization_id = ${organizationId}::uuid
  FOR UPDATE
`;
```

For a subscription grant:

- idempotency key is `stripe:invoice:${invoiceId}:included`;
- create a bucket of `includedMinutes * 60`;
- set expiry to Stripe `periodEnd`;
- priority is `10`;
- add a `subscription_grant` ledger entry;
- increment available seconds.

For a purchased pack:

- idempotency key is `stripe:checkout:${checkoutSessionId}:topup`;
- grant exactly `6_000` seconds;
- expiry is purchase time plus 365 days;
- priority is `20`.

- [ ] **Step 4: Implement reservations and compensation**

Reservation consumes bucket availability in priority and expiry order but records the amount as reserved until connection. Store bucket allocations in ledger metadata:

```ts
type ReservationAllocation = {
  bucketId: string;
  seconds: number;
};
```

`commitReservation` moves reserved seconds to debited seconds. `releaseReservation` returns the exact allocations to their buckets. Duplicate idempotency keys return the existing result without another mutation.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/credit-ledger.service.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
```

Expected: both commands exit `0`.

- [ ] **Step 6: Commit the ledger**

```powershell
git add apps/api/src/billing/credit-ledger.service.ts apps/api/src/billing/credit-ledger.service.test.ts apps/api/src/billing/billing.module.ts
git commit -m "feat(billing): implement transactional minute credits"
```

---

### Task 4: Centralize Organization Entitlements

**Files:**
- Create: `apps/api/src/billing/entitlement.service.ts`
- Create: `apps/api/src/billing/entitlement.service.test.ts`
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/src/billing/billing.service.ts`
- Modify: `apps/api/src/billing/billing.service.test.ts`

**Interfaces:**
- Consumes: `getPlanEntitlements`, Subscription, credit balance, and quota counts.
- Produces:

```ts
getEffectivePlan(organizationId: string): Promise<EffectivePlan>
check(organizationId: string, request: EntitlementRequest): Promise<EntitlementDecision>
assertAllowed(organizationId: string, request: EntitlementRequest): Promise<EntitlementDecision>
```

- [ ] **Step 1: Write status and quota tests**

```ts
it.each(['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'])(
  'blocks paid calls when subscription status is %s',
);
it('allows active subscription through its cancel-at-period end');
it('allows an unexpired paid trial and rejects an expired paid trial');
it('evaluates agents and workspaces across the organization, not one workspace');
it('returns stable current, limit, reason, and catalogVersion fields');
it('blocks Free outbound PSTN even when legacy UsageRecord rows exist');
it('blocks paid calls while the credit balance is in manual review');
it('clamps an Enterprise concurrency override to the contractual maximum of 50');
```

- [ ] **Step 2: Run tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/entitlement.service.test.ts
```

Expected: failure because the centralized entitlement service does not exist.

- [ ] **Step 3: Implement effective-plan resolution**

Use:

```ts
export type EffectivePlan = {
  organizationId: string;
  plan: PlanType;
  status: SubscriptionStatus | 'none';
  catalogVersion: string;
  entitlements: PlanEntitlements;
  paidAccess: boolean;
};
```

Only `active` and an unexpired `trialing` state produce `paidAccess: true`. Free remains Free whether or not a legacy local subscription row says `active`.

A `paid_call` decision also loads `OrganizationCreditBalance`. Status `manual_review` returns `billing_temporarily_unavailable`, and fewer than the requested `minimumSeconds` returns `credit_insufficient`.

Only Enterprise may use `Subscription.concurrentCallLimitOverride`; resolve it as `Math.min(override, 50)`. Starter and Growth always use catalog concurrency even if stale metadata contains another value.

- [ ] **Step 4: Implement typed entitlement requests**

Support:

```ts
type EntitlementRequest =
  | { kind: 'paid_call'; minimumSeconds: 60 }
  | { kind: 'browser_test' }
  | { kind: 'agent_create'; current: number }
  | { kind: 'workspace_create'; current: number }
  | { kind: 'integration_connect'; current: number }
  | { kind: 'white_label' }
  | { kind: 'campaign_launch' };
```

Every decision contains `allowed`, `reason`, `plan`, `current`, `limit`, `catalogVersion`, and a generated `correlationId`.

- [ ] **Step 5: Replace legacy BillingService feature switches**

Keep compatibility methods temporarily, but delegate them to `EntitlementService`. Change `checkFeatureGate('outbound')` so Free is false and inactive paid states are false. Remove monthly call-count admission from `canStartOutboundCall`; later tasks replace it with credit and concurrency admission.

- [ ] **Step 6: Run focused regression tests**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/entitlement.service.test.ts src/billing/billing.service.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit entitlements**

```powershell
git add apps/api/src/billing/entitlement.service.ts apps/api/src/billing/entitlement.service.test.ts apps/api/src/billing/billing.module.ts apps/api/src/billing/billing.service.ts apps/api/src/billing/billing.service.test.ts
git commit -m "feat(billing): centralize organization entitlements"
```

---

### Task 5: Enforce the 100-Call Platform Limit With Redis Leases

**Files:**
- Create: `apps/api/src/billing/call-concurrency.service.ts`
- Create: `apps/api/src/billing/call-concurrency.service.test.ts`
- Create: `apps/api/src/billing/call-concurrency.integration.test.ts`
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `QueueService.getConnection()` and effective plan concurrency.
- Produces:

```ts
acquire(input: AcquireCallLeaseInput): Promise<CallLeaseDecision>
renew(input: RenewCallLeaseInput): Promise<boolean>
release(input: ReleaseCallLeaseInput): Promise<void>
recoverFromPostgres(): Promise<LeaseRecoveryReport>
```

- [ ] **Step 1: Write failing concurrency tests**

Cover:

```ts
it('allows global slot 100 and rejects slot 101');
it('enforces Starter at 2 calls across two workspaces');
it('enforces Enterprise configured concurrency no higher than 50');
it('returns the same lease for a duplicate call id');
it('renews only when the lease token matches');
it('releases global and organization counters atomically');
it('fails closed when Redis is unavailable');
```

- [ ] **Step 2: Run tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/call-concurrency.service.test.ts
```

Expected: failure because `CallConcurrencyService` does not exist.

- [ ] **Step 3: Implement atomic Redis scripts**

Use Redis sorted sets:

- `vf:v1:billing:concurrency:global`;
- `vf:v1:billing:concurrency:org:{organizationId}`.

The acquisition Lua script removes expired members, checks both cardinalities, and inserts `callId|leaseToken` with the expiry score in one script. Use `BILLING_GLOBAL_CONCURRENCY=100` and `BILLING_LEASE_TTL_SECONDS=90`.

Return:

```ts
type CallLeaseDecision =
  | { allowed: true; leaseToken: string; expiresAt: string }
  | {
      allowed: false;
      reason: 'organization_concurrency_reached' | 'platform_concurrency_reached' | 'billing_temporarily_unavailable';
    };
```

- [ ] **Step 4: Persist recovery records**

After Redis acquisition, upsert `CallConcurrencyLease`. If PostgreSQL persistence fails, immediately run the token-matched release script and return a billing-unavailable denial.

- [ ] **Step 5: Run tests and typecheck**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/call-concurrency.service.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
```

Expected: both commands exit `0`.

- [ ] **Step 6: Add the real-Redis capacity test**

The integration test must skip only when `REDIS_URL` is absent. It acquires 101 unique call IDs in parallel, asserts 100 allowed and one `platform_concurrency_reached`, releases every allowed token, and asserts both sorted sets return to cardinality zero.

Run:

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/call-concurrency.integration.test.ts
```

Expected with Redis configured: one test passes with exactly 100 allowed leases.

- [ ] **Step 7: Commit concurrency enforcement**

```powershell
git add apps/api/src/billing/call-concurrency.service.ts apps/api/src/billing/call-concurrency.service.test.ts apps/api/src/billing/call-concurrency.integration.test.ts apps/api/src/billing/billing.module.ts apps/api/src/config/env.ts .env.example
git commit -m "feat(billing): enforce distributed call concurrency"
```

---

### Task 6: Make Stripe Subscriptions and Minute Packs Grant Credits Safely

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`
- Modify: `apps/api/src/billing/billing.service.ts`
- Modify: `apps/api/src/billing/billing.service.test.ts`
- Modify: `apps/api/src/webhooks/stripe-webhook.service.ts`
- Modify: `apps/api/src/webhooks/stripe-webhook.service.test.ts`

**Interfaces:**
- Consumes: shared catalog, `CreditLedgerService`, and `CacheService`.
- Produces: verified subscription and top-up Checkout plus webhook-driven credit grants.

- [ ] **Step 1: Upgrade Stripe and write failing Checkout tests**

Run:

```powershell
pnpm --filter @voiceforge/api add stripe@22.3.2
```

Add tests asserting:

```ts
expect(subscriptionCheckout).toMatchObject({
  mode: 'subscription',
  line_items: [{ price: 'price_starter_99', quantity: 1 }],
  automatic_tax: { enabled: false },
});
expect(topUpCheckout).toMatchObject({
  mode: 'payment',
  line_items: [{ price: 'price_100_minutes_39', quantity: 1 }],
  metadata: {
    organizationId: 'org-1',
    purchaseType: 'minute_pack',
    catalogVersion: '2026-07-24',
  },
});
```

Also assert subscription Checkout rejects Enterprise and top-up Checkout rejects Free or inactive subscriptions.

- [ ] **Step 2: Run the Checkout tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/billing.service.test.ts
```

Expected: failure because the existing implementation enables automatic tax and has no pack Checkout.

- [ ] **Step 3: Implement server-owned Checkout configuration**

Add:

```ts
STRIPE_MINUTE_PACK_PRICE_ID: z.string().optional(),
STRIPE_TAX_ENABLED: BooleanEnvSchema.default(false),
```

Instantiate Stripe with:

```ts
new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: Stripe.LATEST_API_VERSION,
  maxNetworkRetries: 2,
});
```

Store a random `integration_identifier` suffix in Checkout metadata for each request, do not pass `payment_method_types`, and never accept a Price ID from the client.

Remove `BILLING_MODE`. `getBillingStatus()` reports Checkout configured only when the Stripe secret, webhook secret, Starter Price, Growth Price, and minute-pack Price are present; otherwise Checkout and Portal endpoints return `BILLING_UNAVAILABLE` without changing customer state.

- [ ] **Step 4: Write failing webhook grant and reversal tests**

Cover:

```ts
it('grants included seconds once for a paid subscription invoice');
it('does not grant subscription credit from checkout.session.completed');
it('grants 6000 seconds once for a paid minute-pack Checkout');
it('ignores a pack event whose metadata organization does not own the Stripe customer');
it('reverses unused pack credit after charge.refunded');
it('flags manual review after a dispute when pack credit was consumed');
it('invalidates the subscription cache after every subscription status event');
it('handles reordered invoice and subscription events without granting the wrong plan');
it('reclaims a webhook claim whose processing lease expired after a crash');
```

- [ ] **Step 5: Implement webhook dispatch**

For `invoice.paid`:

1. resolve subscription from Stripe customer;
2. resolve plan from the server-owned price mapping;
3. update subscription period and status;
4. call `grantSubscriptionCredits` with the Stripe invoice ID;
5. audit grant and invalidate `billing:subscription:{organizationId}`.

For a pack, grant only when Checkout reports `payment_status === 'paid'` and `purchaseType === 'minute_pack'`. Handle `charge.refunded` and `charge.dispute.closed` with source identifiers recorded during pack grant.

Treat an unprocessed StripeEvent with `processingStartedAt` older than five minutes as reclaimable. Increment `attemptCount` atomically when it is reclaimed; a duplicate with an active processing lease remains acknowledged without dispatch.

- [ ] **Step 6: Run Stripe tests and typecheck**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/billing.service.test.ts src/webhooks/stripe-webhook.service.test.ts src/webhooks/stripe-webhook.controller.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit Stripe revenue flows**

```powershell
git add apps/api/package.json pnpm-lock.yaml apps/api/src/config/env.ts .env.example apps/api/src/billing/billing.service.ts apps/api/src/billing/billing.service.test.ts apps/api/src/webhooks/stripe-webhook.service.ts apps/api/src/webhooks/stripe-webhook.service.test.ts
git commit -m "feat(billing): add prepaid Stripe credit grants"
```

---

### Task 7: Enforce the One-Lifetime Free Browser Test

**Files:**
- Create: `apps/api/src/billing/trial.service.ts`
- Create: `apps/api/src/billing/trial.service.test.ts`
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/src/voice/voice-provider.registry.ts`
- Modify: `apps/api/src/voice/voice-provider.registry.test.ts`
- Modify: `apps/api/src/voice/adapters/voice.provider.interface.ts`
- Modify: `apps/api/src/voice/adapters/vapi.adapter.ts`
- Modify: `apps/api/src/voice/adapters/retell.adapter.ts`
- Modify: `apps/api/src/calls/calls.service.ts`
- Modify: `apps/api/src/calls/start-test-session.test.ts`
- Create: `apps/api/src/workers/trial-timeout.worker.ts`
- Create: `apps/api/src/workers/trial-timeout.worker.test.ts`
- Modify: `apps/api/src/workers/workers.module.ts`

**Interfaces:**
- Consumes: `TrialRedemption`, `AgentProviderDeployment`, Vapi and Retell adapters.
- Produces:

```ts
startLifetimeBrowserTest(input: StartTrialInput): Promise<TrialSessionResult>
finalizeTrial(input: FinalizeTrialInput): Promise<void>
VoiceProviderRegistry.browserTestProviders(): readonly [VapiVoiceAdapter, RetellVoiceAdapter]
```

- [ ] **Step 1: Write failing lifetime and fallback tests**

Cover:

```ts
it('creates the redemption before contacting Vapi');
it('uses Vapi when Vapi establishes the session');
it('uses Retell only after Vapi fails to establish the same redemption');
it('does not create another redemption after provider failure');
it('rejects a second test from another workspace in the same organization');
it('stores separate Vapi and Retell runtime deployment ids');
it('returns an expiry no later than 180 seconds from start');
it('enqueues one durable provider termination job at 180 seconds');
```

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/trial.service.test.ts src/calls/start-test-session.test.ts src/voice/voice-provider.registry.test.ts
```

Expected: failure because the current flow has no lifetime redemption or explicit fallback sequence.

- [ ] **Step 3: Implement provider-specific deployments**

Change Vapi and Retell adapter deployment reads/writes to `AgentProviderDeployment`. Do not update the shared `AgentVersion.providerRuntimeId` from a browser-test deployment.

Use:

```ts
await tx.agentProviderDeployment.upsert({
  where: { agentVersionId_provider: { agentVersionId, provider } },
  create: { organizationId, workspaceId, agentVersionId, provider, providerRuntimeId },
  update: { providerRuntimeId, status: 'active' },
});
```

- [ ] **Step 4: Implement atomic trial claim and same-redemption fallback**

The unique organization constraint is the claim. A Prisma `P2002` maps to `trial_already_used`. Record each provider attempt in ordered JSON, but never delete the redemption when both providers fail.

Clamp provider result expiry:

```ts
const hardExpiry = new Date(redemption.startedAt.getTime() + 180_000);
const expiresAt = new Date(Math.min(new Date(providerResult.expires_at).getTime(), hardExpiry.getTime()));
```

- [ ] **Step 5: Enforce the duration on the provider and with a durable timeout**

Pass `maxDurationSeconds: 180` through `CreateBrowserTestSessionInput`. Configure the provider-side maximum when the provider supports it. Independently enqueue:

```ts
await this.queue.queue('billing-trial-timeout').add(
  'end',
  { redemptionId: redemption.id },
  { delay: 180_000, jobId: redemption.id, removeOnComplete: true },
);
```

`TrialTimeoutWorker` loads the redemption, calls the selected adapter's `endCall` with `reason: 'trial_limit_reached'`, and finalizes the redemption. Duplicate jobs and already-ended sessions return successfully without a second provider mutation.

Export `TrialService` from `BillingModule`, import `BillingModule` into `WorkersModule`, and register `TrialTimeoutWorker` in the worker providers and exports.

- [ ] **Step 6: Replace CallsService browser-test flow**

Resolve agent and validated Agent Spec, then delegate to `TrialService`. Persist the `Call` with `direction: 'browser_test'`, the selected provider, the redemption ID in metadata, and `organizationId`.

- [ ] **Step 7: Run tests and typecheck**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/trial.service.test.ts src/workers/trial-timeout.worker.test.ts src/calls/start-test-session.test.ts src/voice/voice-provider.registry.test.ts src/voice/adapters/vapi.adapter.test.ts src/voice/adapters/retell.adapter.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
```

Expected: all commands exit `0`.

- [ ] **Step 8: Commit lifetime trial enforcement**

```powershell
git add apps/api/src/billing/trial.service.ts apps/api/src/billing/trial.service.test.ts apps/api/src/billing/billing.module.ts apps/api/src/voice/voice-provider.registry.ts apps/api/src/voice/voice-provider.registry.test.ts apps/api/src/voice/adapters/voice.provider.interface.ts apps/api/src/voice/adapters/vapi.adapter.ts apps/api/src/voice/adapters/retell.adapter.ts apps/api/src/calls/calls.service.ts apps/api/src/calls/start-test-session.test.ts apps/api/src/workers/trial-timeout.worker.ts apps/api/src/workers/trial-timeout.worker.test.ts apps/api/src/workers/workers.module.ts
git commit -m "feat(billing): enforce lifetime browser test"
```

---

### Task 8: Coordinate Paid Call Admission Before LiveKit Dispatch

**Files:**
- Create: `apps/api/src/billing/call-admission.service.ts`
- Create: `apps/api/src/billing/call-admission.service.test.ts`
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/src/telephony/telephony.service.ts`
- Modify: `apps/api/src/telephony/telephony.service.test.ts`
- Modify: `apps/api/src/calls/calls.service.ts`
- Modify: `apps/api/src/calls/start-outbound-idempotency.test.ts`
- Modify: `apps/api/src/outbound-campaign/workers/outbound-call.worker.ts`
- Modify: `apps/api/src/outbound-campaign/workers/outbound-call.worker.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `EntitlementService`, `CreditLedgerService`, and `CallConcurrencyService`.
- Produces:

```ts
admitPaidCall(input: PaidCallAdmissionInput): Promise<PaidCallAdmission>
releaseUnconnected(input: ReleaseAdmissionInput): Promise<void>
markDispatchFailed(input: DispatchFailureInput): Promise<void>
```

- [ ] **Step 1: Write failing admission-order tests**

Assert this exact order:

1. compliance completes;
2. an organization-scoped Call row exists;
3. paid entitlement is checked;
4. concurrency lease is acquired;
5. 60 seconds are reserved;
6. provider dispatch occurs.

Also test that credit failure releases the concurrency lease and dispatch failure releases both the lease and minute reservation.

Test enforcement controls:

```ts
it('blocks every new paid call when BILLING_ENFORCEMENT_MODE is halt');
it('enforces billing by default for organizations outside the internal shadow allowlist');
it('records would-deny audit data for an explicitly shadowed internal organization');
```

- [ ] **Step 2: Run admission tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/call-admission.service.test.ts src/telephony/telephony.service.test.ts
```

Expected: failure because existing telephony dispatch has no credit reservation or global lease.

- [ ] **Step 3: Implement admission compensation**

Return:

```ts
export type PaidCallAdmission = {
  callId: string;
  organizationId: string;
  leaseToken: string;
  reservationId: string | null;
  enforcement: 'enforced' | 'shadow';
  correlationId: string;
};
```

If any stage fails, compensate only the completed stages in reverse order. Every allow, denial, and compensation creates an audit record with the correlation ID.

- [ ] **Step 4: Refactor outbound LiveKit dispatch around a pre-created Call**

Generate the Call before `createOutboundCall`, pass its ID to LiveKit metadata, and update provider fields after dispatch:

```ts
metadata: {
  callId: call.id,
  organizationId: workspace.organizationId,
  workspaceId,
  phoneNumberId: number.id,
  agentId: number.assignedAgentId,
  provider: number.provider,
  direction: 'outbound',
}
```

On provider exception, call `markDispatchFailed`, set Call status to `failed`, and rethrow a stable provider error.

Add:

```ts
BILLING_ENFORCEMENT_MODE: z.enum(['enforce', 'halt']).default('enforce'),
BILLING_SHADOW_ORGANIZATION_IDS: z.string().default(''),
```

`halt` is the emergency rollback and denies all new paid calls. Shadow mode is not a global bypass: only organization IDs explicitly present in `BILLING_SHADOW_ORGANIZATION_IDS` may continue after a would-deny decision, and each such decision must be audited.

Shadow organizations must still have an active paid subscription and must still pass compliance plus organization/global concurrency. They skip customer-credit debit only so the new meter can be compared with legacy usage during rollout; their admission returns `reservationId: null` and `enforcement: 'shadow'`. Migrate them to expiring named credit buckets before removing them from the allowlist.

- [ ] **Step 5: Gate inbound Twilio and VoBiz before LiveKit routing**

After signature verification and compliance, call admission must succeed before returning LiveKit SIP routing. On denial, persist the call decision and return provider-specific spoken-unavailable/hangup markup without connecting to LiveKit.

When LiveKit connects, update `livekitRoomName`; this enables the agent runtime to resolve inbound `callId` by room name.

For provider terminal statuses before LiveKit connection (`busy`, `no-answer`, `failed`, `canceled`, or provider equivalent), call `releaseUnconnected` idempotently. Do not wait for a LiveKit Agent event because the agent never started.

- [ ] **Step 6: Remove paid Vapi/Retell outbound fallback**

`CallsService.startOutboundCall` returns `TELEPHONY_NOT_CONFIGURED` for paid PSTN attempts that do not select an owned Twilio/VoBiz number. `OutboundCallWorker` must mark the job failed when no assigned BYO number exists; it must not call the generic voice provider.

- [ ] **Step 7: Run call-path tests and typecheck**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/call-admission.service.test.ts src/telephony/telephony.service.test.ts src/calls/start-outbound-idempotency.test.ts src/outbound-campaign/workers/outbound-call.worker.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
```

Expected: all commands exit `0`.

- [ ] **Step 8: Commit paid-call admission**

```powershell
git add apps/api/src/billing/call-admission.service.ts apps/api/src/billing/call-admission.service.test.ts apps/api/src/billing/billing.module.ts apps/api/src/telephony/telephony.service.ts apps/api/src/telephony/telephony.service.test.ts apps/api/src/calls/calls.service.ts apps/api/src/calls/start-outbound-idempotency.test.ts apps/api/src/outbound-campaign/workers/outbound-call.worker.ts apps/api/src/outbound-campaign/workers/outbound-call.worker.test.ts apps/api/src/config/env.ts .env.example
git commit -m "feat(billing): admit paid calls before LiveKit dispatch"
```

---

### Task 9: Meter Connected Minutes Through Signed Runtime Events

**Files:**
- Create: `apps/api/src/billing/runtime-usage.service.ts`
- Create: `apps/api/src/billing/runtime-usage.service.test.ts`
- Create: `apps/api/src/billing/runtime-usage.controller.ts`
- Create: `apps/api/src/billing/runtime-usage.controller.test.ts`
- Create: `apps/livekit-agent/src/billing-runtime-client.ts`
- Create: `apps/livekit-agent/src/billing-runtime-client.test.ts`
- Modify: `apps/livekit-agent/src/index.ts`
- Modify: `apps/livekit-agent/src/agent-runtime.ts`
- Modify: `apps/livekit-agent/src/agent-runtime.test.ts`
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: credit ledger, call leases, CallUsage, and shared runtime-event schemas.
- Produces: `POST /internal/billing/runtime-events` and LiveKit runtime metering loop.

- [ ] **Step 1: Write failing signature and metering tests**

Cover:

```ts
it('rejects a signature generated with the wrong secret');
it('rejects an event timestamp older than 60 seconds');
it('returns the stored decision for a duplicate event id');
it('commits the initial minute only after call_connected');
it('releases the minute after call_failed before connection');
it('bills one minute for a connected call lasting one second');
it('reserves and debits each next minute at its boundary');
it('schedules a warning during the final paid minute');
it('returns end_now when no funded time remains');
it('renews the concurrency lease on a valid heartbeat');
it('releases the lease and finalizes once on call_ended');
it('retries a runtime event with the same event id');
it('ends a call when initial connected billing cannot be confirmed');
it('does not extend paidUntil when a minute-boundary request fails');
```

- [ ] **Step 2: Run tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/runtime-usage.service.test.ts src/billing/runtime-usage.controller.test.ts
pnpm --filter @voiceforge/livekit-agent exec vitest run src/billing-runtime-client.test.ts
```

Expected: failure because the runtime event service and client do not exist.

- [ ] **Step 3: Implement HMAC request authentication**

Add `BILLING_RUNTIME_HMAC_SECRET` with a production minimum of 32 bytes and optional `BILLING_RUNTIME_HMAC_PREVIOUS_SECRET` for rotation. Sign:

```text
{unixTimestamp}.{rawJsonBody}
```

Send `x-voiceforge-timestamp`, `x-voiceforge-event-id`, and `x-voiceforge-signature`. Use SHA-256 HMAC and constant-time comparison. Persist the event ID before mutation so replay cannot double-debit.

Mark only this controller `@Public()` to bypass the frontend-oriented `InternalAuthGuard`; its HMAC verification remains mandatory and runs before Zod parsing or mutation. Accept the current secret first and the previous secret only during a logged rotation window. Load the call by `callId`, derive the authoritative organization from PostgreSQL, and reject the event if its signed `organizationId` differs. Add `VOICEFORGE_API_BASE_URL` to the LiveKit Agent environment for this endpoint.

- [ ] **Step 4: Implement runtime usage decisions**

Return:

```ts
type RuntimeUsageDecision = {
  action: 'continue' | 'schedule_warning_and_end' | 'end_now';
  remainingSeconds: number;
  leaseExpiresAt: string | null;
  warningAt: string | null;
  paidUntil: string | null;
  reason: 'funded' | 'credit_exhausted' | 'subscription_inactive' | 'call_finalized';
};
```

`call_connected` commits the first reservation. Each `minute_boundary` atomically reserves and debits the next 60 seconds. After a successful debit, if fewer than 60 seconds remain, return `schedule_warning_and_end` with `warningAt` 30 seconds before `paidUntil`. If a boundary arrives with no funded minute, return `end_now` and do not generate unpaid speech. `call_ended` records raw duration, calculates `billableSeconds = Math.ceil(rawSeconds / 60) * 60`, finalizes usage idempotently, and releases the lease. Finalization never debits beyond funded seconds; a larger raw duration becomes a provider-cost discrepancy alert rather than a negative customer balance.

- [ ] **Step 5: Implement the LiveKit metering loop**

Resolve outbound calls from dispatch `callId`. Resolve inbound calls by retrying the API with `roomName` until the verified telephony webhook has linked the room.

After connection:

1. post `call_connected`;
2. schedule the next boundary relative to connection time;
3. post `minute_boundary`;
4. when action is `schedule_warning_and_end`, schedule `session.generateReply` for `warningAt` with a fixed low-balance message;
5. call `ctx.shutdown('credit_exhausted')` no later than `paidUntil`;
6. post `call_ended` from a registered shutdown callback.

Use `AbortController` to stop heartbeat timers during shutdown.

The client retries a failed HTTP request up to three times with the same event ID. If `call_connected` cannot be confirmed, shut down without beginning the agent greeting. If a later boundary cannot be confirmed, do not extend the locally stored `paidUntil`; terminate at that already-funded timestamp.

- [ ] **Step 6: Run runtime tests and typechecks**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/runtime-usage.service.test.ts src/billing/runtime-usage.controller.test.ts
pnpm --filter @voiceforge/livekit-agent exec vitest run src/billing-runtime-client.test.ts src/agent-runtime.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @voiceforge/livekit-agent exec tsc -p tsconfig.json --noEmit
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit signed runtime metering**

```powershell
git add apps/api/src/billing/runtime-usage.service.ts apps/api/src/billing/runtime-usage.service.test.ts apps/api/src/billing/runtime-usage.controller.ts apps/api/src/billing/runtime-usage.controller.test.ts apps/api/src/billing/billing.module.ts apps/api/src/config/env.ts .env.example apps/livekit-agent/src/billing-runtime-client.ts apps/livekit-agent/src/billing-runtime-client.test.ts apps/livekit-agent/src/index.ts apps/livekit-agent/src/agent-runtime.ts apps/livekit-agent/src/agent-runtime.test.ts
git commit -m "feat(billing): meter LiveKit calls with signed events"
```

---

### Task 10: Track Provider Costs and Reconcile Billing State

**Files:**
- Create: `apps/api/src/billing/provider-cost.service.ts`
- Create: `apps/api/src/billing/provider-cost.service.test.ts`
- Create: `apps/api/src/billing/reconciliation.service.ts`
- Create: `apps/api/src/billing/reconciliation.service.test.ts`
- Create: `apps/api/src/workers/billing-reconciliation.worker.ts`
- Modify: `apps/api/src/workers/workers.module.ts`
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/src/common/metrics.service.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: finalized CallUsage, provider usage, ledger, balance projection, and leases.
- Produces: provider cost events, repair reports, margin metrics, and alerts.

- [ ] **Step 1: Write failing provider-cost tests**

Test:

```ts
it('estimates a connected minute at the configured 0.12 USD reserve');
it('records OpenAI, LiveKit agent, and LiveKit SIP categories separately');
it('replaces an estimated event when actual provider usage arrives');
it('does not alter customer debits while reconciling provider costs');
```

- [ ] **Step 2: Write failing reconciliation tests**

Test:

```ts
it('repairs a balance projection with a compensating audited entry');
it('expires a bucket and decrements available balance once');
it('finalizes a stale unconnected call and releases its reservation');
it('recreates a lease for a provider-confirmed active call');
it('marks ambiguous provider state for review without redispatch');
it('reports missing provider costs above one percent');
```

- [ ] **Step 3: Run tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/provider-cost.service.test.ts src/billing/reconciliation.service.test.ts
```

Expected: failure because both services do not exist.

- [ ] **Step 4: Implement provider cost records**

Add `BILLING_VARIABLE_COST_RESERVE_USD_PER_MINUTE=0.12`. When actual data is unavailable, record a versioned estimate with `isEstimate: true`. Never combine provider cost and customer ledger records.

- [ ] **Step 5: Implement idempotent reconciliation batches**

Use organization-scoped advisory locks and batches of at most 100 records. Emit a report:

```ts
type BillingReconciliationReport = {
  organizationsChecked: number;
  projectionCorrections: number;
  expiredBuckets: number;
  staleCallsFinalized: number;
  leasesRecovered: number;
  costEventsEstimated: number;
  manualReviewsCreated: number;
};
```

- [ ] **Step 6: Register a BullMQ reconciliation worker**

The worker handles named jobs `balances`, `stale_calls`, `leases`, `costs`, and `margins`. Configure repeatable schedules in worker startup; each processor calls one bounded reconciliation method.

- [ ] **Step 7: Add Prometheus metrics**

Add gauges/counters:

- `voiceforge_billing_available_seconds`;
- `voiceforge_billing_reserved_seconds`;
- `voiceforge_calls_active_global`;
- `voiceforge_calls_admission_denied_total{reason}`;
- `voiceforge_provider_cost_usd_total{provider,category,estimate}`;
- `voiceforge_plan_contribution_margin_ratio{plan}`;
- `voiceforge_billing_reconciliation_corrections_total{type}`.

- [ ] **Step 8: Run tests and typecheck**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/provider-cost.service.test.ts src/billing/reconciliation.service.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
```

Expected: both commands exit `0`.

- [ ] **Step 9: Commit cost controls and reconciliation**

```powershell
git add apps/api/src/billing/provider-cost.service.ts apps/api/src/billing/provider-cost.service.test.ts apps/api/src/billing/reconciliation.service.ts apps/api/src/billing/reconciliation.service.test.ts apps/api/src/workers/billing-reconciliation.worker.ts apps/api/src/workers/workers.module.ts apps/api/src/billing/billing.module.ts apps/api/src/common/metrics.service.ts apps/api/src/config/env.ts .env.example
git commit -m "feat(billing): reconcile provider costs and balances"
```

---

### Task 11: Apply Agent, Workspace, and Integration Quotas

**Files:**
- Modify: `apps/api/src/agents/agents.service.ts`
- Modify: `apps/api/src/agents/agents.service.test.ts`
- Modify: `apps/api/src/orchestrator/orchestrator.service.ts`
- Modify: `apps/api/src/white-label/white-label.service.ts`
- Modify: `apps/api/src/white-label/white-label.test.ts`
- Modify: `apps/api/src/workspace-crm/workspace-crm.service.ts`
- Modify: `apps/api/src/workspace-crm/workspace-crm.service.test.ts`
- Modify: `apps/api/src/calendar/calendar.service.ts`
- Create: `apps/api/src/calendar/calendar.service.test.ts`

**Interfaces:**
- Consumes: `EntitlementService.assertAllowed`.
- Produces: organization-wide quota enforcement at every current creation boundary.

- [ ] **Step 1: Write failing organization-wide quota tests**

Test that:

- the fourth Starter agent is blocked even when agents are split across workspaces;
- Starter cannot create a second workspace;
- the third Starter integration connection is blocked across CRM and Calendar;
- Growth accepts the tenth connection and blocks the eleventh;
- denials include stable reason, current, limit, and upgrade path;
- no record is created after denial.

- [ ] **Step 2: Run tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/agents/agents.service.test.ts src/white-label/white-label.test.ts src/workspace-crm/workspace-crm.service.test.ts src/calendar/calendar.service.test.ts
```

Expected: at least the workspace and integration tests fail because those paths do not use centralized entitlements.

- [ ] **Step 3: Add checks immediately before creation transactions**

Count organization records from PostgreSQL, then call:

```ts
await this.entitlements.assertAllowed(organizationId, {
  kind: 'integration_connect',
  current: existingConnectionCount,
});
```

CRM and Calendar share one total connection count. The later Nango milestone will replace the underlying records while keeping the same entitlement call.

- [ ] **Step 4: Run quota regressions and typecheck**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/agents/agents.service.test.ts src/white-label/white-label.test.ts src/workspace-crm/workspace-crm.service.test.ts src/calendar/calendar.service.test.ts
pnpm --filter @voiceforge/api exec tsc -p tsconfig.json --noEmit
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit quota boundaries**

```powershell
git add apps/api/src/agents/agents.service.ts apps/api/src/agents/agents.service.test.ts apps/api/src/orchestrator/orchestrator.service.ts apps/api/src/white-label/white-label.service.ts apps/api/src/white-label/white-label.test.ts apps/api/src/workspace-crm/workspace-crm.service.ts apps/api/src/workspace-crm/workspace-crm.service.test.ts apps/api/src/calendar/calendar.service.ts apps/api/src/calendar/calendar.service.test.ts
git commit -m "feat(billing): enforce organization plan quotas"
```

---

### Task 12: Expose Billing Balances and Update the Revenue UI

**Files:**
- Modify: `apps/api/src/billing/billing.controller.ts`
- Modify: `apps/api/src/billing/billing.service.ts`
- Modify: `apps/api/src/billing/billing.service.test.ts`
- Modify: `apps/web/components/pricing-page.tsx`
- Modify: `apps/web/components/billing-panel.tsx`
- Modify: `apps/web/lib/pricing-estimator.ts`
- Modify: `apps/web/lib/pricing-estimator.test.ts`
- Modify: `apps/web/app/pricing/page.tsx`
- Modify: `apps/web/app/api/billing/checkout/route.ts`
- Create: `apps/web/app/api/billing/topup/route.ts`
- Delete: `apps/web/lib/billing-mode.ts`
- Delete: `apps/web/lib/billing-mode.test.ts`

**Interfaces:**
- Consumes: shared DTOs, catalog, Stripe Checkout, credit ledger, and call usage.
- Produces: authenticated balance, usage, and pack-purchase experience.

- [ ] **Step 1: Write failing API and estimator tests**

Test:

```ts
it('returns organization totals even when opened from one workspace');
it('shows included, purchased, reserved, and expiring seconds separately');
it('starts top-up Checkout without accepting a client price id');
it('recommends Starter for 200 minutes and Growth for 201 minutes when quotas otherwise fit');
it('calculates two prepaid packs for 1,150 Growth minutes');
```

- [ ] **Step 2: Run tests and confirm failure**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/billing.service.test.ts
pnpm --filter @voiceforge/web exec vitest run lib/pricing-estimator.test.ts
```

Expected: failures because current usage is workspace/month based and no pack route exists.

- [ ] **Step 3: Add organization billing reads**

Expose:

- `GET /workspaces/:workspaceId/billing/summary`;
- `GET /workspaces/:workspaceId/billing/usage`;
- `POST /workspaces/:workspaceId/billing/topup-checkout`;

The summary returns subscription, catalog version, included/purchased/reserved/expiring seconds, effective quotas, current organization counts, and latest stable denial reason.

- [ ] **Step 4: Replace all pricing and FAQ copy**

The UI must state:

- Free is one lifetime browser test, maximum three minutes;
- no Free phone number or PSTN call;
- paid prices and included minutes exactly match the catalog;
- Twilio or VoBiz charges are separate and paid directly by the customer;
- every started connected minute is charged;
- unanswered calls use zero VoiceForge minutes;
- included minutes do not roll over;
- purchased packs expire after 12 months;
- Enterprise is sales-assisted;
- checkout return pages wait for webhook-confirmed state.

Remove claims for unlimited usage, annual rollover, free inbound calls, 14-day Starter trial, HIPAA readiness, SLA, and multi-region deployment.

Remove the demo-billing fallback and its “free trial limits remain active” copy from the pricing page, Next.js Checkout route, and dashboard. Missing Stripe configuration produces a clear temporary-unavailable state; it never activates recurring Free minutes.

- [ ] **Step 5: Build balance and top-up controls**

Show four values:

```ts
[
  ['Included', summary.includedSeconds],
  ['Purchased', summary.purchasedSeconds],
  ['Reserved by active calls', summary.reservedSeconds],
  ['Expiring in 30 days', summary.expiringSeconds],
]
```

Enable “Buy 100 minutes — $39” only when the subscription has paid access. After Checkout return, display “Payment received by Stripe; credits appear after verification” until the webhook-refetched balance changes.

- [ ] **Step 6: Run web and API verification**

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/billing.service.test.ts
pnpm --filter @voiceforge/web exec vitest run lib/pricing-estimator.test.ts
pnpm --filter @voiceforge/web exec tsc -p tsconfig.json --noEmit
pnpm --filter @voiceforge/web exec eslint app components lib middleware.ts middleware-utils.ts next.config.ts
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit the revenue UI**

```powershell
git add apps/api/src/billing/billing.controller.ts apps/api/src/billing/billing.service.ts apps/api/src/billing/billing.service.test.ts apps/web/components/pricing-page.tsx apps/web/components/billing-panel.tsx apps/web/lib/pricing-estimator.ts apps/web/lib/pricing-estimator.test.ts apps/web/app/pricing/page.tsx apps/web/app/api/billing/checkout/route.ts apps/web/app/api/billing/topup/route.ts apps/web/lib/billing-mode.ts apps/web/lib/billing-mode.test.ts
git commit -m "feat(billing): expose balances and prepaid checkout"
```

---

### Task 13: Add Operations Runbook and Complete Rollout Verification

**Files:**
- Create: `docs/operations/billing-runbook.md`
- Modify: `.env.example`
- Verify: all files changed by Tasks 1–12

**Interfaces:**
- Consumes: the complete billing implementation.
- Produces: deployable configuration, rollback instructions, and fresh release evidence.

- [ ] **Step 1: Write the operations runbook**

Document exact setup for:

- Stripe products and monthly Prices: Starter `$99`, Growth `$299`, Enterprise sales-assisted from `$999`;
- one-time Stripe Price: 100-minute pack `$39`;
- webhook events and signing secret;
- `STRIPE_TAX_ENABLED=false` launch default;
- Redis readiness and fail-closed behavior;
- 100 global slots and plan-level slots;
- runtime HMAC secret rotation;
- enabling shadow metering;
- checking ledger projection reconciliation;
- rollback flags that stop new calls without corrupting active calls;
- refund/dispute manual review;
- margin alerts at 50% plan contribution and `$0.12` estimated variable cost per minute.

- [ ] **Step 2: Run the migration in a disposable PostgreSQL environment**

Run:

```powershell
pnpm --filter @voiceforge/api exec prisma migrate deploy
pnpm db:verify
```

Expected: both commands exit `0`; the migration reports no null `calls.organization_id` rows.

- [ ] **Step 3: Run the complete automated verification**

Run:

```powershell
$env:CI = 'true'
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: every command exits `0`, with zero failed tests, TypeScript errors, lint errors, build failures, or whitespace errors.

- [ ] **Step 4: Run Stripe CLI webhook scenarios**

With test-mode secrets loaded:

```powershell
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
stripe trigger checkout.session.completed
stripe trigger charge.refunded
```

Expected:

- duplicate delivery does not duplicate grants;
- `invoice.paid` grants the plan's included seconds once;
- payment failure blocks new calls;
- a generic Checkout event without the server-created minute-pack metadata grants no credit;
- refund removes unused purchased seconds or creates manual review when consumed.

- [ ] **Step 5: Run the concurrency acceptance test**

Use the integration test harness to acquire 101 unique call leases concurrently:

```powershell
pnpm --filter @voiceforge/api exec vitest run src/billing/call-concurrency.integration.test.ts
```

Expected: exactly 100 acquisitions return allowed and exactly one returns `platform_concurrency_reached`; releasing all allowed leases returns the global count to zero.

- [ ] **Step 6: Run the end-to-end revenue acceptance test**

Verify in test mode:

1. Free completes one browser test and a second workspace attempt is denied.
2. Free cannot connect Twilio/VoBiz or start PSTN.
3. Starter payment grants 12,000 seconds only after `invoice.paid`.
4. A no-answer releases 60 reserved seconds and bills zero.
5. A one-second connected call bills 60 seconds.
6. A pack payment grants 6,000 seconds only after verified webhook.
7. A past-due organization cannot start a call or campaign.
8. Customer ledger and provider cost records remain separate.

Record call IDs, Stripe event IDs, ledger entry IDs, and final balances in the release evidence.

- [ ] **Step 7: Commit operations documentation**

```powershell
git add docs/operations/billing-runbook.md .env.example
git commit -m "docs(billing): add production operations runbook"
```

- [ ] **Step 8: Request code review**

Use `superpowers:requesting-code-review` against the complete implementation diff. Resolve every critical or high-severity issue, rerun Step 3, and record the fresh command output in the handoff.

---

## Completion Gate

Do not enable live billing or paid call dispatch until all statements below have fresh evidence:

- Free has no PSTN path and exactly one organization-lifetime browser test.
- Stripe grants revenue-backed credit only from verified, idempotent webhooks.
- Customer balance cannot become negative.
- Compliance completes before call admission.
- Redis and organization capacity are acquired before provider dispatch.
- The platform admits no more than 100 connecting or connected calls.
- A no-answer releases its entire reservation.
- A connected partial minute consumes one minute.
- Runtime event replay cannot double-debit.
- Vapi and Retell runtime deployments cannot overwrite each other.
- Paid campaigns cannot fall back to platform-funded Vapi or Retell calling.
- Subscription, pack, usage, provider-cost, and audit records are organization scoped.
- The dashboard uses the same catalog as backend enforcement.
- Full tests, typecheck, lint, build, Prisma verification, and diff checks pass.
