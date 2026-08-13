import { describe, expect, it } from 'vitest';
import { config } from './middleware';
import { POSTHOG_PROXY_PREFIX } from './lib/analytics/posthog-config';

/**
 * The matcher is a Next.js path-to-regexp source containing a negative
 * lookahead. Next compiles it itself at build time, so these tests compile the
 * lookahead directly: the point is to prove which paths the lookahead excludes,
 * not to re-implement Next's router.
 */
function matches(pathname: string): boolean {
  const entry = config.matcher[0];
  if (!entry || typeof entry.source !== 'string') {
    throw new Error('middleware config must declare a string matcher source');
  }
  // '/((?!a|b).*)' -> '^/(?:(?!a|b).*)$'
  const inner = entry.source.replace(/^\/\(/, '').replace(/\)$/, '');
  return new RegExp(`^/(?:${inner})$`).test(pathname);
}

describe('middleware matcher', () => {
  it('does not run on PostHog proxy ingestion requests', () => {
    expect(matches(`${POSTHOG_PROXY_PREFIX}/e/`)).toBe(false);
    expect(matches(`${POSTHOG_PROXY_PREFIX}/i/v0/e/`)).toBe(false);
    expect(matches(`${POSTHOG_PROXY_PREFIX}/flags`)).toBe(false);
    expect(matches(`${POSTHOG_PROXY_PREFIX}/s/`)).toBe(false);
  });

  it('does not run on PostHog proxy asset or remote-config requests', () => {
    expect(matches(`${POSTHOG_PROXY_PREFIX}/static/recorder.js`)).toBe(false);
    expect(matches(`${POSTHOG_PROXY_PREFIX}/array/phc_token/config.js`)).toBe(false);
  });

  it('excludes the prefix declared in posthog-config, catching a rename', () => {
    const entry = config.matcher[0];
    expect(entry?.source).toContain(POSTHOG_PROXY_PREFIX.replace(/^\//, ''));
  });

  it('still runs on application routes', () => {
    expect(matches('/')).toBe(true);
    expect(matches('/dashboard')).toBe(true);
    expect(matches('/dashboard/calls/abc')).toBe(true);
    expect(matches('/sign-in')).toBe(true);
  });

  it('still excludes the API and Next.js internals', () => {
    expect(matches('/api/proxy/auth/me')).toBe(false);
    expect(matches('/_next/static/chunk.js')).toBe(false);
    expect(matches('/favicon.ico')).toBe(false);
  });

  it('does not exclude routes that merely start with reserved prefix text', () => {
    expect(matches('/vf-relay-not-analytics')).toBe(true);
    expect(matches('/apiary')).toBe(true);
    expect(matches('/dashboard/vf-relay')).toBe(true);
  });
});
