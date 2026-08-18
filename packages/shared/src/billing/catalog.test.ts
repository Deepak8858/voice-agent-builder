import { describe, expect, it } from 'vitest';
import {
  BILLING_CATALOG_VERSION,
  getPlanById,
  getPlanEntitlements,
  MINUTE_PACK,
} from './catalog';

describe('plan catalog', () => {
  it('matches the approved launch prices and quotas', () => {
    expect(BILLING_CATALOG_VERSION).toBe('2026-07-24');
    expect(getPlanById('free')).toMatchObject({ monthlyPriceUsd: 0 });
    expect(getPlanById('starter')).toMatchObject({ monthlyPriceUsd: 99 });
    expect(getPlanById('growth')).toMatchObject({ monthlyPriceUsd: 299 });
    expect(getPlanById('enterprise')).toMatchObject({
      monthlyPriceUsd: 999,
      priceLabel: 'From $999/month',
    });

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
});
