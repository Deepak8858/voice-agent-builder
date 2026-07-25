import { describe, expect, it } from 'vitest';
import {
  CreateCheckoutSessionDtoSchema,
  CreatePortalSessionDtoSchema,
  CreateTopUpCheckoutDtoSchema,
  EntitlementDecisionSchema,
  PLAN_LIMITS,
  RuntimeUsageEventSchema,
  SubscriptionStatusSchema,
} from './billing';

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
    expect(PLAN_LIMITS.free).toMatchObject({ minutes: 0, outboundCalls: 0 });
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
    }).success).toBe(true);
  });

  it('requires tenant-scoped, idempotent runtime usage events', () => {
    const event = {
      eventId: 'evt_123',
      callId: 'call_123',
      organizationId: 'org_123',
      occurredAt: '2026-07-24T12:00:00.000Z',
      type: 'minute_boundary',
      minute: 1,
    };

    expect(RuntimeUsageEventSchema.safeParse(event).success).toBe(true);
    expect(RuntimeUsageEventSchema.safeParse({ ...event, organizationId: undefined }).success).toBe(false);
    expect(RuntimeUsageEventSchema.safeParse({ ...event, type: 'call_ended' }).success).toBe(false);
  });
});
