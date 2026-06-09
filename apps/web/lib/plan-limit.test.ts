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
});
