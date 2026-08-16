import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

describe('env validation', () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('requires VOICE_WEBHOOK_SECRET in production', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: '',
    });

    await expect(import('./env')).rejects.toThrow(/VOICE_WEBHOOK_SECRET/);
  });

  it('rejects the mock voice provider in production', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: 'production-webhook-secret',
      VOICE_PROVIDER: 'mock',
    });

    await expect(import('./env')).rejects.toThrow(/VOICE_PROVIDER=mock/);
  });

  it('does not reject a malformed optional PostHog host while analytics is disabled', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
      POSTHOG_ENABLED: 'false',
      POSTHOG_HOST: 'not-a-url',
    });

    const mod = await import('./env');
    expect(mod.env.POSTHOG_ENABLED).toBe(false);
    expect(mod.env.POSTHOG_HOST).toBe('not-a-url');
  });

  it('rejects unsafe release metadata', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
      APP_VERSION: 'release with spaces',
    });

    await expect(import('./env')).rejects.toThrow(/APP_VERSION/);
  });

  it('parses WORKERS_ENABLED explicitly and defaults it off', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
    });

    let mod = await import('./env');
    expect(mod.env.WORKERS_ENABLED).toBe(false);

    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
      WORKERS_ENABLED: 'true',
    });

    mod = await import('./env');
    expect(mod.env.WORKERS_ENABLED).toBe(true);
  });

  /**
   * WEB_BASE_URL defaults to localhost and is what Stripe redirects customers
   * back to after checkout. A live deployment that forgets to set it takes real
   * payments and then sends the customer to a dead address — a failure no boot
   * or health check would surface.
   */
  describe('live billing requires a reachable public URL', () => {
    const liveBase = {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
      BILLING_MODE: 'live',
    };

    it.each([
      ['the default localhost value', undefined],
      ['an explicit localhost URL', 'http://localhost:3000'],
      ['a loopback IP', 'https://127.0.0.1:3000'],
      ['plain HTTP on a real domain', 'http://app.voiceforge.example'],
      ['a non-absolute value', 'app.voiceforge.example'],
    ])('rejects %s when BILLING_MODE=live', async (_label, webBaseUrl) => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, liveBase);
      if (webBaseUrl !== undefined) process.env.WEB_BASE_URL = webBaseUrl;

      await expect(import('./env')).rejects.toThrow(/WEB_BASE_URL/);
    });

    it('accepts an absolute HTTPS URL when BILLING_MODE=live', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, liveBase, { WEB_BASE_URL: 'https://incfrog.ai' });

      const mod = await import('./env');
      expect(mod.env.WEB_BASE_URL).toBe('https://incfrog.ai');
    });

    it('leaves the localhost default alone in demo mode', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, {
        NODE_ENV: 'development',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'development-jwt-secret-with-32-chars',
      });

      const mod = await import('./env');
      expect(mod.env.BILLING_MODE).toBe('demo');
      expect(mod.env.WEB_BASE_URL).toBe('http://localhost:3000');
    });
  });

  describe('weekly digest schedule', () => {
    it('defaults to Monday 09:00 UTC', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, {
        NODE_ENV: 'development',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'development-jwt-secret-with-32-chars',
      });

      const mod = await import('./env');
      expect(mod.env.WEEKLY_DIGEST_CRON).toBe('0 9 * * 1');
      expect(mod.env.WEEKLY_DIGEST_TIMEZONE).toBe('UTC');
    });

    it('rejects a malformed cron expression rather than silently never firing', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, {
        NODE_ENV: 'development',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'development-jwt-secret-with-32-chars',
        WEEKLY_DIGEST_CRON: 'every monday',
      });

      await expect(import('./env')).rejects.toThrow(/WEEKLY_DIGEST_CRON/);
    });
  });
});
