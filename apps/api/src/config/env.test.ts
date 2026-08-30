import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

  /**
   * Neither variable is individually required, and supabase-auth.service.ts
   * treats both as optional, so a production deployment with neither boots
   * clean, passes /health, and then rejects every authenticated request —
   * resolveClaims() skips local verification and getSupabaseUser() returns null
   * before it issues a request. Boot has to refuse instead.
   */
  it.each([
    ['the JWT secret alone', { SUPABASE_JWT_SECRET: 'production-supabase-jwt-secret' }],
    ['the service-role key alone', { SUPABASE_SERVICE_ROLE_KEY: 'production-service-role-key' }],
  ])('accepts %s as a claims source in production', async (_label, claimsSource) => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: 'production-webhook-secret',
      VOICE_PROVIDER: 'openai-realtime',
      LLM_BASE_URL: 'https://llm.voiceforge.example',
      ...claimsSource,
    });

    await expect(import('./env')).resolves.toBeDefined();
  });

  /**
   * `' '` is truthy, so a whitespace-only credential used to satisfy the
   * presence check above: boot stayed clean and then local verification had no
   * usable secret and introspection sent a blank service-role key, so every
   * authenticated request was rejected.
   */
  it.each([
    ['a whitespace-only JWT secret', { SUPABASE_JWT_SECRET: '   ' }],
    ['a whitespace-only service-role key', { SUPABASE_SERVICE_ROLE_KEY: '\t' }],
    [
      'whitespace-only values for both',
      { SUPABASE_JWT_SECRET: ' ', SUPABASE_SERVICE_ROLE_KEY: ' ' },
    ],
  ])('refuses to boot in production on %s', async (_label, claimsSource) => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: 'production-webhook-secret',
      VOICE_PROVIDER: 'openai-realtime',
      LLM_BASE_URL: 'https://llm.voiceforge.example',
      ...claimsSource,
    });

    await expect(import('./env')).rejects.toThrow(/SUPABASE_JWT_SECRET/);
  });

  /**
   * SUPABASE_URL becomes the Supabase client base URL, the expected JWT issuer
   * and the base of every /auth/v1 request URL, so a whitespace-only or
   * malformed value has to fail at boot rather than per request. Whitespace-only
   * counts as absent, which is why the fallback variable is consulted for it.
   */
  it.each([
    ['whitespace only', '   '],
    ['not a URL at all', 'test-project.supabase.co'],
    ['a URL with a leading space that is still malformed', ' supabase'],
  ])('rejects a Supabase URL that is %s', async (_label, supabaseUrl) => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
      SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_URL: '  ',
    });

    await expect(import('./env')).rejects.toThrow(/SUPABASE_URL/);
  });

  it('trims the selected Supabase URL and falls back past a whitespace-only value', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
      SUPABASE_URL: ' \t ',
      NEXT_PUBLIC_SUPABASE_URL: '  https://fallback-project.supabase.co  ',
    });

    const mod = await import('./env');
    expect(mod.env.SUPABASE_URL).toBe('https://fallback-project.supabase.co');
  });

  it('refuses to boot in production with no Supabase claims source at all', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: 'production-webhook-secret',
      VOICE_PROVIDER: 'openai-realtime',
      LLM_BASE_URL: 'https://llm.voiceforge.example',
    });

    await expect(import('./env')).rejects.toThrow(/SUPABASE_JWT_SECRET/);
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

  it('normalizes a supported voice provider value before returning it', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
      VOICE_PROVIDER: '  OPENAI-REALTIME  ',
    });

    const mod = await import('./env');
    expect(mod.env.VOICE_PROVIDER).toBe('openai-realtime');
  });

  /**
   * Removing the Vapi/Retell variables must not break an existing deployment
   * that still sets them: a boot failure here would take the whole API down on
   * upgrade. Zod strips unknown keys, so the contract is "boot, then warn".
   */
  it('boots with stale Vapi/Retell variables and reports them as ignored', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: 'production-webhook-secret',
      VOICE_PROVIDER: 'vapi',
      LLM_BASE_URL: 'https://llm.voiceforge.example',
      SUPABASE_SERVICE_ROLE_KEY: 'production-service-role-key',
      VAPI_API_KEY: 'stale-vapi-key',
      RETELL_VOICE_ID: '11labs-Adrian',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const mod = await import('./env');

      // A retired selection resolves to the supported Realtime adapter rather
      // than aborting boot on a value the operator cannot yet change.
      expect(mod.env.VOICE_PROVIDER).toBe('openai-realtime');
      expect(mod.env).not.toHaveProperty('VAPI_API_KEY');
      expect(mod.findRemovedVoiceEnvVars()).toEqual([
        'VAPI_API_KEY',
        'RETELL_VOICE_ID',
        'VOICE_PROVIDER',
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('VAPI_API_KEY'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('RETELL_VOICE_ID'));
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet about removed voice variables when none are set', async () => {
    vi.resetModules();
    restoreEnv();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('VAPI_') || key.startsWith('RETELL_')) delete process.env[key];
    }
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
    });

    const mod = await import('./env');
    expect(mod.findRemovedVoiceEnvVars()).toEqual([]);
  });

  describe('in-house standard pipeline configuration', () => {
    const productionBase = {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: 'production-webhook-secret',
      VOICE_PROVIDER: 'openai-realtime',
      LLM_BASE_URL: 'https://llm.voiceforge.example',
      // Production requires a Supabase claims source. vitest.setup.ts supplies
      // SUPABASE_URL but deliberately not this, so every production fixture has
      // to name it or the schema rejects before reaching what it is testing.
      SUPABASE_SERVICE_ROLE_KEY: 'production-service-role-key',
    };
    const azureBase = {
      AZURE_OPENAI_ENDPOINT: 'https://voiceforge.openai.azure.com',
      AZURE_OPENAI_API_KEY: 'azure-openai-key',
      AZURE_VOICE_LLM_DEPLOYMENT: 'voice-brain',
      AZURE_SPEECH_KEY: 'azure-speech-key',
      AZURE_SPEECH_REGION: 'eastus',
    };

    it('defaults off so no plan is routed to an unconfigured pipeline', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, {
        NODE_ENV: 'development',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'development-jwt-secret-with-32-chars',
      });

      const mod = await import('./env');
      expect(mod.env.VOICE_STANDARD_PIPELINE_ENABLED).toBe(false);
      expect(mod.env.AZURE_TTS_VOICE).toBe('en-US-AvaMultilingualNeural');
    });

    it.each(Object.keys(azureBase))(
      'fails production boot when %s is missing but the pipeline is enabled',
      async (missing) => {
        vi.resetModules();
        restoreEnv();
        const azure = { ...azureBase } as Record<string, string>;
        delete azure[missing];
        Object.assign(process.env, productionBase, azure, {
          VOICE_STANDARD_PIPELINE_ENABLED: 'true',
        });

        await expect(import('./env')).rejects.toThrow(new RegExp(missing));
      },
    );

    it('accepts a fully configured pipeline in production', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, productionBase, azureBase, {
        VOICE_STANDARD_PIPELINE_ENABLED: 'true',
      });

      const mod = await import('./env');
      expect(mod.env.VOICE_STANDARD_PIPELINE_ENABLED).toBe(true);
      expect(mod.env.AZURE_VOICE_LLM_DEPLOYMENT).toBe('voice-brain');
    });

    it('does not require Azure credentials while the pipeline is disabled', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, productionBase, { VOICE_STANDARD_PIPELINE_ENABLED: 'false' });

      const mod = await import('./env');
      expect(mod.env.VOICE_STANDARD_PIPELINE_ENABLED).toBe(false);
      expect(mod.env.AZURE_SPEECH_KEY).toBeUndefined();
    });
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
     * A deployment that can still charge somebody must be guarded, even when the
     * rest of the Stripe configuration is incomplete: with both plan prices set
     * and no minute-pack price, subscription Checkout takes real payments and
     * would redirect the customer to localhost.
     */
    it('rejects the localhost default when only the minute-pack price is missing', async () => {
      vi.resetModules();
      restoreEnv();
      const { STRIPE_MINUTE_PACK_PRICE_ID: _omitted, ...partial } = configuredBase;
      Object.assign(process.env, partial);

      await expect(import('./env')).rejects.toThrow(/WEB_BASE_URL/);
    });

    /**
     * A half-configured deployment that cannot charge anyone at all must not
     * block boot for the rest of the product: no complete price set means no
     * Checkout session, so a localhost redirect is unreachable. This is the
     * ordinary local-development configuration.
     */
    it('leaves the localhost default alone when no entry point is fully priced', async () => {
      vi.resetModules();
      restoreEnv();
      const {
        STRIPE_MINUTE_PACK_PRICE_ID: _pack,
        STRIPE_GROWTH_PRICE_ID: _growth,
        ...partial
      } = configuredBase;
      Object.assign(process.env, partial);

      const mod = await import('./env');
      expect(mod.env.WEB_BASE_URL).toBe('http://localhost:3000');
    });

    /**
     * Selling only packs is a legitimate half-configured state and still takes
     * money, so it is guarded too.
     */
    it('rejects the localhost default when only the minute pack is priced', async () => {
      vi.resetModules();
      restoreEnv();
      const {
        STRIPE_STARTER_PRICE_ID: _starter,
        STRIPE_GROWTH_PRICE_ID: _growth,
        ...partial
      } = configuredBase;
      Object.assign(process.env, partial);

      await expect(import('./env')).rejects.toThrow(/WEB_BASE_URL/);
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
      VOICE_PROVIDER: 'openai-realtime',
      LLM_BASE_URL: 'https://llm.voiceforge.example',
      SUPABASE_SERVICE_ROLE_KEY: 'production-service-role-key',
    };

    it.each([
      ['a localhost HTTP URL', 'http://localhost:3000/integrations/google/callback'],
      ['a localhost HTTPS URL', 'https://localhost:3000/integrations/google/callback'],
      ['a loopback IP', 'https://127.0.0.1/integrations/google/callback'],
      ['the unspecified IPv4 address', 'https://0.0.0.0/integrations/google/callback'],
      ['the unspecified IPv6 address', 'https://[::]/integrations/google/callback'],
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

  /**
   * A test-mode Stripe key in production is a silent revenue outage: Checkout
   * opens, the customer completes it, nothing settles, and live-mode webhook
   * signatures never verify against a test secret. Boot succeeded and /health
   * stayed green, so the only symptom was that no money arrived.
   */
  describe('Stripe configuration in production', () => {
    const productionBase = {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
      ALLOWED_ORIGINS: 'https://app.voiceforge.example',
      VOICE_WEBHOOK_SECRET: 'production-webhook-secret',
      VOICE_PROVIDER: 'openai-realtime',
      LLM_BASE_URL: 'https://llm.voiceforge.example',
      SUPABASE_SERVICE_ROLE_KEY: 'production-service-role-key',
    };

    it.each([
      ['a test secret key', 'sk_test_51abcdefghijklmnop'],
      ['a test restricted key', 'rk_test_51abcdefghijklmnop'],
    ])('refuses to boot on %s', async (_label, key) => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, productionBase, { STRIPE_SECRET_KEY: key });

      await expect(import('./env')).rejects.toThrow(/STRIPE_SECRET_KEY/);
    });

    it('accepts a live key', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, productionBase, {
        STRIPE_SECRET_KEY: 'sk_live_51abcdefghijklmnop',
      });

      const mod = await import('./env');
      expect(mod.env.STRIPE_SECRET_KEY).toBe('sk_live_51abcdefghijklmnop');
    });

    it('leaves a test key alone outside production', async () => {
      vi.resetModules();
      restoreEnv();
      Object.assign(process.env, {
        NODE_ENV: 'development',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'development-jwt-secret-with-32-chars',
        STRIPE_SECRET_KEY: 'sk_test_51abcdefghijklmnop',
      });

      const mod = await import('./env');
      expect(mod.env.STRIPE_SECRET_KEY).toBe('sk_test_51abcdefghijklmnop');
    });

    /**
     * Every STRIPE_* field is optional, so an incomplete configuration boots
     * clean and /health (db/redis/llm) stays green while a paying customer gets
     * a 503 on their upgrade click. Boot has to say which actions are dead.
     */
    describe('reports which billing actions are disabled', () => {
      const liveStripe = {
        STRIPE_SECRET_KEY: 'sk_live_51abcdefghijklmnop',
        STRIPE_WEBHOOK_SECRET: 'whsec_live',
        WEB_BASE_URL: 'https://incfrog.ai',
      };

      async function warningsFrom(overrides: Record<string, string>): Promise<string[]> {
        vi.resetModules();
        restoreEnv();
        Object.assign(process.env, productionBase, overrides);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          await import('./env');
          return warn.mock.calls.map((call) => String(call[0]));
        } finally {
          warn.mockRestore();
        }
      }

      it('names the missing variable and the actions it disables', async () => {
        const messages = await warningsFrom({
          ...liveStripe,
          STRIPE_STARTER_PRICE_ID: 'price_starter',
          STRIPE_GROWTH_PRICE_ID: 'price_growth',
        });

        const stripeWarning = messages.find((message) => message.includes('return 503'));
        expect(stripeWarning).toBeDefined();
        expect(stripeWarning).toContain('minute-pack top-up');
        expect(stripeWarning).toContain('STRIPE_MINUTE_PACK_PRICE_ID');
        // Subscription checkout and the portal are configured; naming them here
        // would make the warning noise an operator learns to ignore.
        expect(stripeWarning).not.toContain('subscription checkout');
        expect(stripeWarning).not.toContain('customer portal');
      });

      it('stays quiet once every entry point is configured', async () => {
        const messages = await warningsFrom({
          ...liveStripe,
          STRIPE_STARTER_PRICE_ID: 'price_starter',
          STRIPE_GROWTH_PRICE_ID: 'price_growth',
          STRIPE_MINUTE_PACK_PRICE_ID: 'price_minute_pack',
        });

        expect(messages.filter((message) => message.includes('return 503'))).toEqual([]);
      });

      it('stays quiet outside production, where no Stripe configuration is expected', async () => {
        vi.resetModules();
        restoreEnv();
        Object.assign(process.env, {
          NODE_ENV: 'development',
          REDIS_URL: 'redis://localhost:6379',
          JWT_SECRET: 'development-jwt-secret-with-32-chars',
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
          await import('./env');
          const messages = warn.mock.calls.map((call) => String(call[0]));
          expect(messages.filter((message) => message.includes('return 503'))).toEqual([]);
        } finally {
          warn.mockRestore();
        }
      });
    });
  });
});

/**
 * Deploy-gate-vs-code drift guard.
 *
 * The deploy workflow validates the host's hand-maintained /opt/voiceforge/.env
 * against its own hardcoded list; it does not write that file. That list and the
 * code's notion of "Stripe is configured" had drifted into mirror images — the
 * workflow required STRIPE_ENTERPRISE_PRICE_ID and omitted
 * STRIPE_MINUTE_PACK_PRICE_ID, while the code required the minute pack and never
 * read enterprise. A deploy therefore passed every gate, went green on
 * /api/v1/health (db/redis/llm only), and returned 503 from subscription
 * checkout, top-up and the customer portal alike.
 */
describe('deploy gate covers every variable Stripe Checkout requires', () => {
  const root = ((): string => {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
      if (existsSync(path.join(dir, '.github/workflows/deploy-aws-ec2.yml'))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error(`could not locate repo root from ${process.cwd()}`);
  })();

  /** The names in the workflow's `required=( ... )` array — authoritative. */
  const gateRequired = ((): string[] => {
    // Normalized: this file is CRLF on Windows checkouts and LF in CI.
    const src = readFileSync(
      path.join(root, '.github/workflows/deploy-aws-ec2.yml'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const block = /^\s*required=\(\n([\s\S]*?)^\s*\)$/m.exec(src);
    if (!block) throw new Error('could not locate the required=( ... ) list in the deploy workflow');
    return (block[1] as string).split(/\s+/).filter(Boolean);
  })();

  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('is a non-trivial list, so an empty parse cannot pass vacuously', () => {
    expect(gateRequired.length).toBeGreaterThan(20);
  });

  it('requires every variable the API requires for Checkout', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'development-jwt-secret-with-32-chars',
    });

    const { STRIPE_CHECKOUT_REQUIRED_ENV } = await import('./env');
    for (const name of STRIPE_CHECKOUT_REQUIRED_ENV) {
      expect(gateRequired).toContain(name);
    }
  });
});
