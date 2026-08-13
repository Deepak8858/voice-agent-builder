import { describe, expect, it } from 'vitest';
import {
  formatBalance,
  secondsToMinutes,
  toBalanceBuckets,
  type BillingSummaryDto,
} from './billing-summary';

const summary: BillingSummaryDto = {
  organizationId: 'org_1',
  catalogVersion: '2026-07-24',
  plan: 'starter',
  status: 'active',
  paidAccess: true,
  currentPeriodEnd: '2026-08-24T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  includedSeconds: 7_200,
  purchasedSeconds: 6_000,
  reservedSeconds: 120,
  expiringSeconds: 1_800,
  lifetimeBrowserTestSecondsRemaining: 0,
  topUpAvailable: true,
  availableSeconds: 13_200,
  balanceStatus: 'active',
  entitlements: {
    includedMinutes: 120,
    agents: 5,
    workspaces: 3,
    nangoConnections: 5,
    concurrentCalls: 2,
    outboundPstn: true,
    campaigns: false,
    whiteLabel: false,
  },
  usage: {
    agents: 1,
    workspaces: 1,
    integrations: 0,
  },
  blockedReason: 'allowed',
};

describe('billing summary helpers', () => {
  it('rounds partial minutes down because they cannot be spent', () => {
    expect(secondsToMinutes(119)).toBe(1);
    expect(secondsToMinutes(120)).toBe(2);
    expect(secondsToMinutes(0)).toBe(0);
    expect(secondsToMinutes(-5)).toBe(0);
    expect(secondsToMinutes(Number.NaN)).toBe(0);
  });

  it('shows seconds when less than a full minute remains', () => {
    expect(formatBalance(45)).toBe('45 sec');
    expect(formatBalance(0)).toBe('0 sec');
    expect(formatBalance(-10)).toBe('0 sec');
    expect(formatBalance(60)).toBe('1 min');
    expect(formatBalance(60_000)).toBe('1,000 min');
  });

  it('exposes included, purchased, reserved, and expiring separately', () => {
    const buckets = toBalanceBuckets(summary);

    expect(buckets.map((bucket) => bucket.label)).toEqual([
      'Included',
      'Purchased',
      'Reserved by active calls',
      'Expiring in 30 days',
    ]);
    expect(buckets.map((bucket) => bucket.seconds)).toEqual([7_200, 6_000, 120, 1_800]);
  });

  it('never merges included and purchased into a single total', () => {
    const buckets = toBalanceBuckets(summary);
    const included = buckets.find((bucket) => bucket.label === 'Included');
    const purchased = buckets.find((bucket) => bucket.label === 'Purchased');

    expect(formatBalance(included?.seconds ?? 0)).toBe('120 min');
    expect(formatBalance(purchased?.seconds ?? 0)).toBe('100 min');
  });

  it('states that included minutes do not roll over', () => {
    const included = toBalanceBuckets(summary).find((bucket) => bucket.label === 'Included');

    expect(included?.hint).toMatch(/does not roll over/i);
  });
});
