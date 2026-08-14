import { describe, expect, it } from 'vitest';
import {
  BillingStatusDtoSchema,
  BillingSummaryDtoSchema,
  CreateCheckoutSessionDtoSchema,
  CreatePortalSessionDtoSchema,
  CreateTopUpCheckoutDtoSchema,
  EffectiveSubscriptionStatusSchema,
  EntitlementDecisionSchema,
  PLAN_LIMITS,
  RuntimeUsageEventSchema,
  SubscriptionStatusSchema,
} from './billing';

const BILLING_SUMMARY = {
  organizationId: 'org_123',
  plan: 'starter' as const,
  status: 'active' as const,
  paidAccess: true,
  catalogVersion: '2026-07-24',
  currentPeriodEnd: '2026-08-24T12:00:00.000Z',
  cancelAtPeriodEnd: false,
  includedSeconds: 12_000,
  purchasedSeconds: 6_000,
  reservedSeconds: 60,
  expiringSeconds: 12_000,
  lifetimeBrowserTestSecondsRemaining: 0,
  topUpAvailable: true,
  availableSeconds: 18_000,
  balanceStatus: 'active',
  entitlements: {
    includedMinutes: 200,
    agents: 3,
    workspaces: 1,
    nangoConnections: 2,
    concurrentCalls: 2,
    outboundPstn: true,
    campaigns: true,
    whiteLabel: false,
  },
  usage: { agents: 1, workspaces: 1, integrations: 0 },
  blockedReason: 'allowed' as const,
};

describe('billing DTO schemas', () => {
  it('accepts a server-controlled checkout plan and safe relative return paths', () => {
    const result = CreateCheckoutSessionDtoSchema.safeParse({
      plan: 'starter',
      successPath: '/dashboard/billing?checkout=success',
      cancelPath: '/dashboard/billing?checkout=cancel',
    });

    expect(result.success).toBe(true);
  });

  it('rejects client-supplied Stripe price IDs and absolute redirect URLs', () => {
    const result = CreateCheckoutSessionDtoSchema.safeParse({
      priceId: 'price_attacker',
      successUrl: 'https://evil.example/success',
      cancelUrl: 'https://evil.example/cancel',
    });

    expect(result.success).toBe(false);
  });

  it('only accepts self-service checkout plans', () => {
    expect(CreateCheckoutSessionDtoSchema.safeParse({ plan: 'starter' }).success).toBe(true);
    expect(CreateCheckoutSessionDtoSchema.safeParse({ plan: 'growth' }).success).toBe(true);
    expect(CreateCheckoutSessionDtoSchema.safeParse({ plan: 'enterprise' }).success).toBe(false);
  });

  it('accepts only relative Customer Portal return paths', () => {
    expect(CreatePortalSessionDtoSchema.safeParse({
      returnPath: '/dashboard/billing',
    }).success).toBe(true);

    expect(CreatePortalSessionDtoSchema.safeParse({
      returnPath: 'https://evil.example/billing',
    }).success).toBe(false);
  });

  it('does not retain recurring free calling allowances', () => {
    expect(PLAN_LIMITS.free).toMatchObject({ minutes: 0, concurrentCalls: 0 });
    expect(PLAN_LIMITS.starter).not.toHaveProperty('outboundCalls');
  });

  it('defaults strict top-up checkout paths to billing routes', () => {
    expect(CreateTopUpCheckoutDtoSchema.parse({})).toEqual({
      successPath: '/dashboard/billing?topup=success',
      cancelPath: '/dashboard/billing?topup=cancel',
    });
    expect(CreateTopUpCheckoutDtoSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it('recognizes paused subscriptions and stable entitlement reasons', () => {
    expect(SubscriptionStatusSchema.safeParse('paused').success).toBe(true);
    expect(EntitlementDecisionSchema.safeParse({
      organizationId: 'org_123',
      plan: 'starter',
      allowed: false,
      reason: 'credit_insufficient',
      current: 0,
      limit: 60,
      catalogVersion: '2026-07-24',
      correlationId: 'ent_123',
    }).success).toBe(true);
  });

  it('requires explainable numbers on every entitlement decision', () => {
    expect(EntitlementDecisionSchema.safeParse({
      organizationId: 'org_123',
      plan: 'starter',
      allowed: true,
      reason: 'allowed',
    }).success).toBe(false);
  });

  it('treats an organization without a subscription as a resolvable status', () => {
    expect(EffectiveSubscriptionStatusSchema.safeParse('none').success).toBe(true);
    expect(EffectiveSubscriptionStatusSchema.safeParse('active').success).toBe(true);
    expect(EffectiveSubscriptionStatusSchema.safeParse('demo').success).toBe(false);
  });

  it('has no demo billing mode in the checkout availability contract', () => {
    expect(BillingStatusDtoSchema.safeParse({
      checkoutConfigured: false,
      liveCheckoutEnabled: false,
      message: 'Billing is temporarily unavailable.',
    }).success).toBe(true);
    expect(BillingStatusDtoSchema.safeParse({
      mode: 'demo',
      checkoutConfigured: false,
      liveCheckoutEnabled: false,
      message: 'Demo',
    }).success).toBe(false);
  });

  it('reports included, purchased, reserved, and expiring seconds separately', () => {
    const parsed = BillingSummaryDtoSchema.safeParse(BILLING_SUMMARY);

    expect(parsed.success).toBe(true);
    expect(BillingSummaryDtoSchema.safeParse({
      ...BILLING_SUMMARY,
      reservedSeconds: -60,
    }).success).toBe(false);
    const { purchasedSeconds: _purchasedSeconds, ...withoutPurchased } = BILLING_SUMMARY;
    expect(BillingSummaryDtoSchema.safeParse(withoutPurchased).success).toBe(false);
  });

  it('accepts every tenant-scoped, idempotent runtime usage event branch', () => {
    const baseEvent = {
      eventId: 'evt_123',
      callId: 'call_123',
      organizationId: 'org_123',
      occurredAt: '2026-07-24T12:00:00.000Z',
    };

    expect(RuntimeUsageEventSchema.safeParse({
      ...baseEvent,
      type: 'call_connected',
      providerCallId: 'provider_call_123',
    }).success).toBe(true);
    expect(RuntimeUsageEventSchema.safeParse({
      ...baseEvent,
      type: 'minute_boundary',
      minute: 1,
    }).success).toBe(true);
    expect(RuntimeUsageEventSchema.safeParse({
      ...baseEvent,
      type: 'call_ended',
      durationSeconds: 60,
    }).success).toBe(true);
    expect(RuntimeUsageEventSchema.safeParse({
      ...baseEvent,
      type: 'call_failed',
      failureCode: 'provider_unavailable',
    }).success).toBe(true);
  });

  it('rejects missing or cross-branch runtime event fields', () => {
    const baseEvent = {
      eventId: 'evt_123',
      callId: 'call_123',
      organizationId: 'org_123',
      occurredAt: '2026-07-24T12:00:00.000Z',
    };

    expect(RuntimeUsageEventSchema.safeParse({
      ...baseEvent,
      type: 'call_connected',
    }).success).toBe(false);
    expect(RuntimeUsageEventSchema.safeParse({
      ...baseEvent,
      type: 'call_ended',
      durationSeconds: 60,
      minute: 1,
    }).success).toBe(false);
    expect(RuntimeUsageEventSchema.safeParse({
      ...baseEvent,
      type: 'call_failed',
      failureCode: '',
    }).success).toBe(false);
    expect(RuntimeUsageEventSchema.safeParse({
      ...baseEvent,
      organizationId: undefined,
      type: 'minute_boundary',
      minute: 1,
    }).success).toBe(false);
  });
});
