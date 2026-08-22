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
   * back to after checkout. A deployment with working Stripe credentials that
   * forgets to set it takes real payments and then sends the customer to a dead
   * address — a failure no boot or health check would surface.
   */
  describe('configured Stripe Checkout requires a reachable public URL', () => {
    const configuredBase = {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
      STRIPE_SECRET_KEY: 'configured-test-value',
      STRIPE_WEBHOOK_SECRET: 'whsec_configured',
      STRIPE_STARTER_PRICE_ID: 'price_starter',
      STRIPE_GROWTH_PRICE_ID: 'price_growth',
      STRIPE_MINUTE_PACK_PRICE_ID: 'price_minute_pack',
    };

    it.each([
      ['the default localhost value', undefined],
      ['an explicit localhost URL', 'http://localhost:3000'],
      ['a loopback IP', 'https://127.0.0.1:3000'],
      ['plain HTTP on a real domain', 'http://app.voiceforge.example'],
      ['a non-absolute value', 'app.voiceforge.example'],
    ])('rejects %s when Stripe Checkout is configured', async (_label, webBaseUrl) => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, configuredBase);
      if (webBaseUrl !== undefined) process.env.WEB_BASE_URL = webBaseUrl;

      await expect(import('./env')).rejects.toThrow(/WEB_BASE_URL/);
    });

    it('accepts an absolute HTTPS URL when Stripe Checkout is configured', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, configuredBase, { WEB_BASE_URL: 'https://incfrog.ai' });

      const mod = await import('./env');
      expect(mod.env.WEB_BASE_URL).toBe('https://incfrog.ai');
    });

    /**
     * A half-configured deployment must not be treated as live. It cannot take
     * payments at all, so localhost redirects are harmless and must not block
     * boot for the rest of the product.
     */
    it('leaves the localhost default alone when the minute-pack price is missing', async () => {
      vi.resetModules();
      restoreEnv();
      const { STRIPE_MINUTE_PACK_PRICE_ID: _omitted, ...partial } = configuredBase;
      Object.assign(process.env, partial);

      const mod = await import('./env');
      expect(mod.env.WEB_BASE_URL).toBe('http://localhost:3000');
    });

    it('defaults Stripe Tax off so launch never collects tax by accident', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, {
        NODE_ENV: 'development',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'development-jwt-secret-with-32-chars',
      });

      const mod = await import('./env');
      expect(mod.env.STRIPE_TAX_ENABLED).toBe(false);
      expect(mod.env.WEB_BASE_URL).toBe('http://localhost:3000');
    });
  });

  describe('Google OAuth redirect URI', () => {
    const googleBase = {
      REDIS_URL: 'redis://localhost:6379',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
    };
    const productionBase = {
      ...googleBase,
      NODE_ENV: 'production',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: 'production-webhook-secret',
      VOICE_PROVIDER: 'vapi',
      LLM_BASE_URL: 'https://llm.voiceforge.example',
    };

    it.each([
      ['a localhost HTTP URL', 'http://localhost:3000/integrations/google/callback'],
      ['a localhost HTTPS URL', 'https://localhost:3000/integrations/google/callback'],
      ['a loopback IP', 'https://127.0.0.1/integrations/google/callback'],
      ['plain HTTP on a real domain', 'http://app.voiceforge.example/callback'],
    ])('rejects %s in production', async (_label, uri) => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, productionBase, { GOOGLE_OAUTH_REDIRECT_URI: uri });

      await expect(import('./env')).rejects.toThrow(/GOOGLE_OAUTH_REDIRECT_URI/);
    });

    it('accepts a non-local HTTPS URL in production', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, productionBase, {
        GOOGLE_OAUTH_REDIRECT_URI: 'https://app.voiceforge.example/integrations/google/callback',
      });

      const mod = await import('./env');
      expect(mod.env.GOOGLE_OAUTH_REDIRECT_URI).toBe(
        'https://app.voiceforge.example/integrations/google/callback',
      );
    });

    it('accepts a localhost HTTP URL outside production', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, googleBase, {
        NODE_ENV: 'development',
        JWT_SECRET: 'development-jwt-secret-with-32-chars',
        GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/integrations/google/callback',
      });

      const mod = await import('./env');
      expect(mod.env.GOOGLE_OAUTH_REDIRECT_URI).toBe(
        'http://localhost:3000/integrations/google/callback',
      );
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
