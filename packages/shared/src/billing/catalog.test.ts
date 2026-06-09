import { describe, expect, it } from 'vitest';
import { getPlanById } from './catalog';

describe('plan catalog', () => {
  it('keeps Free tool marketing copy aligned with enforced billing limits', () => {
    expect(getPlanById('free')?.marketingLimits.tools).toBe('0 tools');
  });
});
