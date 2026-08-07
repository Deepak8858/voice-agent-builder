import { describe, expect, it } from 'vitest';
import { constantTimeEqual } from './secure-compare';

describe('constantTimeEqual', () => {
  it('accepts identical values', () => {
    expect(constantTimeEqual('secret-value', 'secret-value')).toBe(true);
  });

  it('rejects different values and lengths', () => {
    expect(constantTimeEqual('secret-value', 'secret-valuE')).toBe(false);
    expect(constantTimeEqual('short', 'a-much-longer-secret')).toBe(false);
  });
});
