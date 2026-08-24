import { afterEach, describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from './content-security-policy';

const originalPublicLivekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
const originalLivekitUrl = process.env.LIVEKIT_URL;

afterEach(() => {
  if (originalPublicLivekitUrl === undefined) delete process.env.NEXT_PUBLIC_LIVEKIT_URL;
  else process.env.NEXT_PUBLIC_LIVEKIT_URL = originalPublicLivekitUrl;
  if (originalLivekitUrl === undefined) delete process.env.LIVEKIT_URL;
  else process.env.LIVEKIT_URL = originalLivekitUrl;
});

function connectSrc(policy: string): string {
  return policy.split('; ').find((part) => part.startsWith('connect-src ')) ?? '';
}

describe('buildContentSecurityPolicy', () => {
  it('uses a per-request script nonce and blocks inline script attributes', () => {
    const policy = buildContentSecurityPolicy('nonce-value');
    const scriptDirective = policy.split('; ').find((part) => part.startsWith('script-src '));

    expect(scriptDirective).toContain("'nonce-nonce-value'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('allows the LiveKit socket and its HTTPS origin when configured', () => {
    process.env.NEXT_PUBLIC_LIVEKIT_URL = 'wss://voiceforge.livekit.cloud';

    const directive = connectSrc(buildContentSecurityPolicy('n'));

    expect(directive).toContain('wss://voiceforge.livekit.cloud');
    expect(directive).toContain('https://voiceforge.livekit.cloud');
  });

  it('falls back to the shared LIVEKIT_URL when no public override is set', () => {
    delete process.env.NEXT_PUBLIC_LIVEKIT_URL;
    process.env.LIVEKIT_URL = 'wss://shared.livekit.cloud';

    expect(connectSrc(buildContentSecurityPolicy('n'))).toContain('wss://shared.livekit.cloud');
  });

  it('keeps the tighter policy when no LiveKit URL is configured', () => {
    delete process.env.NEXT_PUBLIC_LIVEKIT_URL;
    delete process.env.LIVEKIT_URL;

    const directive = connectSrc(buildContentSecurityPolicy('n'));

    expect(directive).not.toContain('wss://');
    // A missing value must not leave a dangling separator behind.
    expect(directive).not.toMatch(/\s{2}|\s$/);
  });

  it('ignores a malformed LiveKit URL instead of injecting it into the policy', () => {
    process.env.NEXT_PUBLIC_LIVEKIT_URL = 'not a url';

    const directive = connectSrc(buildContentSecurityPolicy('n'));

    expect(directive).not.toContain('not a url');
  });

  it('serves media from blob URLs so remote LiveKit tracks can be attached', () => {
    expect(buildContentSecurityPolicy('n')).toContain("media-src 'self' blob:");
  });
});
