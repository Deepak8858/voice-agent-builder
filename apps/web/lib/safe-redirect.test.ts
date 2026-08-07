import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './safe-redirect';

describe('safeRedirectPath', () => {
  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example/steal',
    'dashboard',
    '',
  ])('rejects non-local redirect %s', (value) => {
    expect(safeRedirectPath(value)).toBe('/dashboard');
  });

  it('preserves local paths and query strings', () => {
    expect(safeRedirectPath('/checkout/start?plan=starter')).toBe(
      '/checkout/start?plan=starter',
    );
  });
});
