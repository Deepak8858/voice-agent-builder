import { describe, expect, it } from 'vitest';
import { getPlanLimitRedirect } from './plan-limit';

describe('getPlanLimitRedirect', () => {
  it('redirects BYO telephony plan limits to dashboard billing', () => {
    const err = Object.assign(new Error('BYO phone numbers require a paid plan.'), {
      code: 'LIMIT_EXCEEDED',
      limitType: 'byo_telephony',
      currentPlan: 'free',
      upgradePath: '/dashboard/billing',
    });

    expect(getPlanLimitRedirect(err)).toEqual({
      message: 'BYO phone numbers require a paid plan.',
      limitType: 'byo_telephony',
      currentPlan: 'free',
      upgradePath: '/dashboard/billing',
    });
  });

  it('ignores non-plan-limit errors', () => {
    expect(getPlanLimitRedirect(new Error('Network failed'))).toBeNull();
  });

  it('ignores null, undefined, and primitive error values', () => {
    expect(getPlanLimitRedirect(null)).toBeNull();
    expect(getPlanLimitRedirect(undefined)).toBeNull();
    expect(getPlanLimitRedirect('LIMIT_EXCEEDED')).toBeNull();
    expect(getPlanLimitRedirect(42)).toBeNull();
  });

  it('accepts plain non-Error objects and falls back to the default message', () => {
    expect(getPlanLimitRedirect({ code: 'LIMIT_EXCEEDED' })).toEqual({
      message: 'Upgrade your plan to continue.',
      limitType: undefined,
      currentPlan: undefined,
      upgradePath: '/dashboard/billing',
    });
  });

  it('drops non-string limitType and currentPlan metadata', () => {
    const err = Object.assign(new Error('limit'), {
      code: 'LIMIT_EXCEEDED',
      limitType: 7,
      currentPlan: { name: 'free' },
    });

    expect(getPlanLimitRedirect(err)).toEqual({
      message: 'limit',
      limitType: undefined,
      currentPlan: undefined,
      upgradePath: '/dashboard/billing',
    });
  });
});

describe('getPlanLimitRedirect upgrade path sanitization', () => {
  function limitError(upgradePath: unknown): Error {
    return Object.assign(new Error('limit'), { code: 'LIMIT_EXCEEDED', upgradePath });
  }

  it('keeps safe relative upgrade paths', () => {
    expect(getPlanLimitRedirect(limitError('/dashboard/billing?tab=plans'))?.upgradePath).toBe(
      '/dashboard/billing?tab=plans',
    );
  });

  it('falls back for protocol-relative URLs that would leave the origin', () => {
    expect(getPlanLimitRedirect(limitError('//evil.example/phish'))?.upgradePath).toBe(
      '/dashboard/billing',
    );
  });

  it('falls back for absolute URLs', () => {
    expect(getPlanLimitRedirect(limitError('https://evil.example/upgrade'))?.upgradePath).toBe(
      '/dashboard/billing',
    );
  });

  it('falls back for paths containing backslashes', () => {
    expect(getPlanLimitRedirect(limitError('/billing\\@evil.example'))?.upgradePath).toBe(
      '/dashboard/billing',
    );
  });

  it('falls back for non-string or missing upgradePath values', () => {
    expect(getPlanLimitRedirect(limitError(undefined))?.upgradePath).toBe('/dashboard/billing');
    expect(getPlanLimitRedirect(limitError(null))?.upgradePath).toBe('/dashboard/billing');
    expect(getPlanLimitRedirect(limitError(123))?.upgradePath).toBe('/dashboard/billing');
    expect(getPlanLimitRedirect(limitError({ path: '/x' }))?.upgradePath).toBe('/dashboard/billing');
  });
});
