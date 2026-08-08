import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from './content-security-policy';

describe('buildContentSecurityPolicy', () => {
  it('uses a per-request script nonce and blocks inline script attributes', () => {
    const policy = buildContentSecurityPolicy('nonce-value');
    const scriptDirective = policy.split('; ').find((part) => part.startsWith('script-src '));

    expect(scriptDirective).toContain("'nonce-nonce-value'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
  });
});
