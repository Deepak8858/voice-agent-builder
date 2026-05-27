import { describe, expect, it } from 'vitest';
import {
  CreateCheckoutSessionDtoSchema,
  CreatePortalSessionDtoSchema,
  PLAN_LIMITS,
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

  it('accepts only relative Customer Portal return paths', () => {
    expect(CreatePortalSessionDtoSchema.safeParse({
      returnPath: '/dashboard/billing',
    }).success).toBe(true);

    expect(CreatePortalSessionDtoSchema.safeParse({
      returnPath: 'https://evil.example/billing',
    }).success).toBe(false);
  });

  it('gives the free plan the roadmap trial compliance block allowance', () => {
    expect(PLAN_LIMITS.free.complianceBlocks).toBe(10);
  });
});
