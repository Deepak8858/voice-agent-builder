import { describe, expect, it } from 'vitest';
import { estimatePlan, formatEstimateReason } from './pricing-estimator';

describe('pricing estimator', () => {
  it('keeps a workspace on Free when usage fits the free trial limits', () => {
    const estimate = estimatePlan({
      agents: 1,
      minutes: 10,
      outboundCalls: 5,
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
      minutes: 250,
      outboundCalls: 80,
      tools: 3,
      workspaces: 1,
      contacts: 400,
    });

    expect(estimate.planId).toBe('starter');
    expect(estimate.monthlyPriceUsd).toBe(49);
  });

  it('recommends Growth when Starter limits are exceeded', () => {
    const estimate = estimatePlan({
      agents: 5,
      minutes: 1200,
      outboundCalls: 300,
      tools: 10,
      workspaces: 3,
      contacts: 2000,
    });

    expect(estimate.planId).toBe('growth');
    expect(estimate.monthlyPriceUsd).toBe(149);
  });

  it('falls back to Enterprise for unlimited usage needs', () => {
    const estimate = estimatePlan({
      agents: 12,
      minutes: 3000,
      outboundCalls: 700,
      tools: 25,
      workspaces: 6,
      contacts: 8000,
    });

    expect(estimate.planId).toBe('enterprise');
    expect(estimate.monthlyPriceUsd).toBe(null);
    expect(formatEstimateReason(estimate)).toContain('custom Enterprise');
  });
});
