import { describe, expect, it } from 'vitest';
import { estimatePlan, formatEstimateReason } from './pricing-estimator';

describe('pricing estimator', () => {
  it('keeps a workspace on Free when it only needs the browser-test entitlement', () => {
    const estimate = estimatePlan({
      agents: 1,
      minutes: 0,
      concurrentCalls: 0,
      tools: 0,
      workspaces: 1,
      contacts: 50,
    });

    expect(estimate.planId).toBe('free');
    expect(estimate.monthlyPriceUsd).toBe(0);
  });

  it('recommends Starter for paid usage that fits Starter limits', () => {
    const estimate = estimatePlan({
      agents: 2,
      minutes: 200,
      concurrentCalls: 2,
      tools: 2,
      workspaces: 1,
      contacts: 400,
    });

    expect(estimate.planId).toBe('starter');
    expect(estimate.monthlyPriceUsd).toBe(99);
  });

  it('recommends Growth when Starter limits are exceeded', () => {
    const estimate = estimatePlan({
      agents: 5,
      minutes: 1000,
      concurrentCalls: 10,
      tools: 10,
      workspaces: 3,
      contacts: 2000,
    });

    expect(estimate.planId).toBe('growth');
    expect(estimate.monthlyPriceUsd).toBe(299);
  });

  it('uses concurrent-call capacity rather than a billing-period call count', () => {
    const estimate = estimatePlan({
      agents: 3,
      minutes: 200,
      concurrentCalls: 3,
      tools: 2,
      workspaces: 1,
      contacts: 400,
    });

    expect(estimate.planId).toBe('growth');
  });

  it('falls back to sales-assisted Enterprise beyond Growth quotas', () => {
    const estimate = estimatePlan({
      agents: 31,
      minutes: 3001,
      concurrentCalls: 26,
      tools: 25,
      workspaces: 16,
      contacts: 25_001,
    });

    expect(estimate.planId).toBe('enterprise');
    expect(estimate.monthlyPriceUsd).toBe(999);
    expect(formatEstimateReason(estimate)).toContain('sales-assisted Enterprise');
  });
});
