import { describe, expect, it } from 'vitest';
import type { PlanType } from '../schemas/billing';
import {
  allowedPipelines,
  BILLING_CATALOG_VERSION,
  FREE_MONTHLY_MINUTES,
  getPlanById,
  getPlanEntitlements,
  isPipelineAllowed,
  MINUTE_PACK,
} from './catalog';

const ALL_PLANS: PlanType[] = ['free', 'starter', 'growth', 'enterprise'];

describe('plan catalog', () => {
  it('matches the approved launch prices and quotas', () => {
    expect(BILLING_CATALOG_VERSION).toBe('2026-08-23');
    expect(getPlanById('free')).toMatchObject({ monthlyPriceUsd: 0 });
    expect(getPlanById('starter')).toMatchObject({ monthlyPriceUsd: 99 });
    expect(getPlanById('growth')).toMatchObject({ monthlyPriceUsd: 299 });
    expect(getPlanById('enterprise')).toMatchObject({
      monthlyPriceUsd: 999,
      priceLabel: 'From $999/month',
    });

    expect(getPlanEntitlements('free')).toMatchObject({
      includedMinutes: FREE_MONTHLY_MINUTES,
      outboundPstn: false,
      concurrentCalls: 1,
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

  /**
   * A provisioned number is rented on VoiceForge's own Twilio account at a
   * recurring ~$1.15/month, so this quota bounds platform spend rather than
   * customer capacity. Free must be 0: it is refused `managed_telephony` and
   * `byo_telephony` outright, and every paid plan must be able to hold at least
   * one number or the capability it pays for is unusable.
   */
  it('caps held phone numbers at the plan concurrency, and at zero on Free', () => {
    expect(getPlanEntitlements('free').phoneNumbers).toBe(0);
    for (const plan of ['starter', 'growth', 'enterprise'] as const) {
      const entitlements = getPlanEntitlements(plan);
      expect(entitlements.phoneNumbers, `${plan} must be able to hold a number`).toBeGreaterThan(0);
      // A number is an inbound call lane; more numbers than the plan can answer
      // at once buys nothing and only adds carrier rent.
      expect(entitlements.phoneNumbers, `${plan} numbers track concurrency`).toBe(
        entitlements.concurrentCalls,
      );
    }
  });

  it('funds browser tests from the monthly allowance on every plan', () => {
    // A separate lifetime test grant used to cap Free at a single 180-second
    // session, which made the recurring monthly allowance unspendable. No plan
    // may reintroduce a second, parallel browser-test budget.
    for (const plan of ALL_PLANS) {
      expect(getPlanEntitlements(plan)).not.toHaveProperty('lifetimeBrowserTestSeconds');
    }
    expect(getPlanEntitlements('free').includedMinutes).toBeGreaterThan(0);
  });

  it('declares a pipeline mix that sums to 100 on every plan', () => {
    for (const plan of ALL_PLANS) {
      const { realtime, standard } = getPlanEntitlements(plan).pipelineMix;
      expect(realtime + standard, `${plan} mix must be exhaustive`).toBe(100);
    }
  });

  it('sells the free plan only the in-house pipeline', () => {
    expect(getPlanEntitlements('free').pipelineMix).toEqual({ realtime: 0, standard: 100 });
    expect(allowedPipelines('free')).toEqual(['standard']);
    expect(isPipelineAllowed('free', 'realtime')).toBe(false);
    expect(isPipelineAllowed('free', 'standard')).toBe(true);
  });

  it('splits starter evenly and keeps growth and enterprise fully realtime', () => {
    expect(getPlanEntitlements('starter').pipelineMix).toEqual({ realtime: 50, standard: 50 });
    expect(allowedPipelines('starter')).toEqual(['realtime', 'standard']);

    for (const plan of ['growth', 'enterprise'] as const) {
      expect(getPlanEntitlements(plan).pipelineMix).toEqual({ realtime: 100, standard: 0 });
      expect(allowedPipelines(plan)).toEqual(['realtime']);
      expect(isPipelineAllowed(plan, 'standard')).toBe(false);
    }
  });
});
