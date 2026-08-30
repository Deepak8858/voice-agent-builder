import 'dotenv/config';
import { z } from 'zod';

const BooleanEnvSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return value;
}, z.boolean());

const OptionalUrlEnvSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

/**
 * Runtime providers that no longer exist. A deployment that still selects one
 * must keep booting — rejecting the value would take the API down on upgrade
 * for a setting the operator cannot change until the new release is deployed —
 * so the retired value is coerced to the supported Realtime adapter and
 * reported by the deprecation warning below.
 */
const RETIRED_VOICE_PROVIDERS = ['vapi', 'retell'] as const;

const VoiceProviderEnvSchema = z.preprocess(
  (value) => {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === '') return undefined;
      if ((RETIRED_VOICE_PROVIDERS as readonly string[]).includes(normalized)) {
        return 'openai-realtime';
      }
      return normalized;
    }
    return value;
  },
  z.enum(['mock', 'twilio', 'openai-realtime']).optional(),
);

/**
 * Typed env schema. Keep in sync with the monorepo root `.env.example`.
 * We intentionally load from process.env and validate once at boot so a
 * misconfigured environment fails fast with a readable error.
 *
 * Mock providers are available for credential-less development and tests but
 * are rejected in production.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).optional(),
    WEB_PORT: z.coerce.number().int().min(1).optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

    DATABASE_URL: z.string().optional(),
    DIRECT_URL: z.string().optional(),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    AUTH_PROVIDER: z.enum(['supabase']).default('supabase'),
    VOICE_PROVIDER: VoiceProviderEnvSchema,
    // Azure AI Foundry is the production default. The LLM module factory still
    // fails fast at boot when the selected provider's key is missing, so this
    // default does not change credential-less-boot behavior.
    LLM_PROVIDER: z
      .enum(['github', 'openai', 'anthropic', 'azure-aifoundry'])
      .default('azure-aifoundry'),
    EMBEDDING_PROVIDER: z.enum(['openai']).default('openai'),

    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_PHONE_NUMBER_PREFIX: z.string().default('+1'),
    TWILIO_SIP_DOMAIN: z.string().optional(),
    TWILIO_TWIML_WEBHOOK_URL: z.string().optional(),
    TWILIO_STATUS_WEBHOOK_URL: z.string().optional(),

    APP_BASE_URL: z.string().optional(),
    LIVEKIT_URL: z.string().optional(),
    LIVEKIT_API_KEY: z.string().optional(),
    LIVEKIT_API_SECRET: z.string().optional(),
    LIVEKIT_SIP_HOST: z.string().optional(),
    LIVEKIT_ROOM_PREFIX: z.string().default('call'),
    LIVEKIT_AGENT_NAME: z.string().default('voiceforge-agent'),
    LIVEKIT_AGENT_NAME_PREFIX: z.string().default('voiceforge-agent'),
    // There is deliberately no LIVEKIT_WEBHOOK_SECRET or VOBIZ_WEBHOOK_SECRET
    // here. Both existed, both had zero consumers, and both read as the thing
    // that secured their webhook — an operator setting them believed signatures
    // were verified against them. Neither verifier has ever looked at an env
    // var: LiveKitService.verifyWebhook builds a WebhookReceiver from
    // LIVEKIT_API_KEY/LIVEKIT_API_SECRET, and Vobiz verifies against a
    // PER-NUMBER secret decrypted from the phone number's
    // providerMetadata.webhookSecretEncrypted, so neither has a global secret
    // to configure. Adding one back would be a lie, not a feature.
    //
    // Twilio is the exception and is NOT symmetric with Vobiz, so do not
    // generalize from it. There are two Twilio webhook families:
    //   - Legacy platform-owned (`twilio-adapter/`): TwilioSignatureVerifier
    //     signs with the account-level TWILIO_AUTH_TOKEN above, because those
    //     `TwilioPhoneNumber` rows carry no provider connection.
    //   - BYO (`telephony/`): the secret is the connection's decrypted
    //     `authToken`, falling back to the number's webhookSecretEncrypted.
    //     No env var participates in this path.
    VOBIZ_DEFAULT_SIP_DOMAIN: z.string().optional(),

    OPENAI_REALTIME_BASE_URL: z.string().default('https://api.openai.com/v1'),
    OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime-2'),
    OPENAI_REALTIME_VOICE: z.string().default('marin'),

    // In-house "standard" pipeline (Azure Speech STT -> Azure AI Foundry LLM ->
    // Azure Speech TTS). This is the only pipeline the free plan may use, and it
    // serves half of starter-plan calls. Keeping it behind a flag means an
    // operator turns it on only once the Azure resources and quota exist; when it
    // is off, every plan falls back to Realtime and no call can be routed to a
    // half-configured pipeline.
    VOICE_STANDARD_PIPELINE_ENABLED: BooleanEnvSchema.default(false),
    AZURE_OPENAI_ENDPOINT: OptionalUrlEnvSchema,
    AZURE_OPENAI_API_KEY: z.string().optional(),
    // Deployment name of the flagship (non-mini) chat model that acts as the
    // voice brain. Kept as config so the brain can be upgraded without a deploy.
    AZURE_VOICE_LLM_DEPLOYMENT: z.string().optional(),
    AZURE_SPEECH_KEY: z.string().optional(),
    AZURE_SPEECH_REGION: z.string().optional(),
    AZURE_TTS_VOICE: z.string().default('en-US-AvaMultilingualNeural'),

    DEEPGRAM_API_KEY: z.string().optional(),
    DEEPGRAM_STT_MODEL: z.string().default('nova-3'),
    DEEPGRAM_TTS_VOICE: z.string().default('aura-2-en-us'),

    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    WEB_BASE_URL: z.string().default('http://localhost:3000'),
    DEFAULT_COUNTRY: z.string().default('US'),

    // Weekly digest schedule. Defaults to Monday 09:00 UTC. The cron pattern is
    // handed to BullMQ's scheduler, so it must be a 5- or 6-field expression.
    WEEKLY_DIGEST_CRON: z
      .string()
      .default('0 9 * * 1')
      .refine((v) => {
        const fields = v.trim().split(/\s+/).length;
        return fields === 5 || fields === 6;
      }, 'WEEKLY_DIGEST_CRON must be a 5- or 6-field cron expression'),
    WEEKLY_DIGEST_TIMEZONE: z.string().default('UTC'),

    // Knowledge file storage
    KNOWLEDGE_STORAGE_PROVIDER: z.enum(['supabase', 's3']).default('supabase'),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    S3_KNOWLEDGE_BUCKET: z.string().min(1).optional(),
    S3_KNOWLEDGE_PREFIX: z
      .string()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9!_.*'()-]*(\/[a-zA-Z0-9][a-zA-Z0-9!_.*'()-]*)*$/,
        'S3_KNOWLEDGE_PREFIX must be a relative S3 key prefix without leading or trailing slashes',
      )
      .default('knowledge'),

    // Supabase (used by backend for service-role operations)
    //
    // Required, not optional: supabase-auth.service.ts binds the JWT `issuer`
    // claim only when this value is present, so an absent one silently
    // downgrades token verification to "trust any issuer". Accepts
    // NEXT_PUBLIC_SUPABASE_URL as the source because deployments that only set
    // the frontend variable booted fine before this became required.
    // Trimmed and URL-checked, not merely non-empty: this value becomes the
    // Supabase client base URL, the expected JWT `issuer` and the base of every
    // /auth/v1 request URL. A whitespace-only or malformed value passed a
    // non-empty check and then failed per-request instead of at boot.
    SUPABASE_URL: z.preprocess((value) => {
      const direct = typeof value === 'string' ? value.trim() : '';
      if (direct !== '') return direct;
      return process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined;
    }, z.string().url('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) must be an absolute URL')),
    SUPABASE_JWT_SECRET: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_KNOWLEDGE_BUCKET: z.string().min(1).optional(),
    SUPABASE_STORAGE_BUCKET: z.string().min(1).optional(),

    // Shared secret between Next.js frontend and this NestJS API. The
    // frontend is the only legitimate caller; it forwards the Supabase
    // bearer token and the API derives user context server-side. Required:
    // internal-auth.guard.ts compares every request against it, so leaving it
    // unset does not disable the check — it makes the comparison unsatisfiable
    // while the API keeps serving, which is a configuration bug, not a mode.
    INTERNAL_API_KEY: z.string().min(32),

    GITHUB_TOKEN: z.string().optional(),
    LLM_MODEL: z.string().optional(),
    LLM_BASE_URL: OptionalUrlEnvSchema,
    OPENAI_API_KEY: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_API_VERSION: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().optional(),

    // The .min(32) subsumes the old 'change-me-in-development' check: that
    // literal is 24 characters, so it was already rejected before the refine
    // could run. Its twin in main.ts was dead for the same reason.
    JWT_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z.string().optional(),
    /**
     * The AES-256-GCM keyring, as `kid:key` pairs joined by commas, where each
     * key is 32 bytes in 64 hex characters. The first pair encrypts every new
     * value; the rest exist only so rows written earlier keep decrypting, so
     * rotating means prepending a new pair and never deleting an old one.
     *
     * Optional, and unset is the normal state: `ENCRYPTION_KEY` is always in the
     * ring under the key id `legacy`, which is what rows carrying no key id at
     * all (everything written before the ring existed) decrypt with.
     *
     * Validated here rather than where the keys are loaded because a typo would
     * otherwise surface as an undecryptable tenant credential long after boot.
     */
    ENCRYPTION_KEYS: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z
        .string()
        .regex(
          /^[A-Za-z0-9_-]{1,32}:[0-9a-fA-F]{64}(,[A-Za-z0-9_-]{1,32}:[0-9a-fA-F]{64})*$/,
          'ENCRYPTION_KEYS must be comma-separated kid:key pairs, where kid matches ' +
            '[A-Za-z0-9_-]{1,32} and key is 64 hex characters (32 bytes)',
        )
        .optional(),
    ),

    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // Where Google sends the browser back after consent. Must exactly match an
    // authorized redirect URI on the OAuth client in Google Cloud Console.
    GOOGLE_OAUTH_REDIRECT_URI: OptionalUrlEnvSchema,

    // Stripe is either fully configured with server-owned prices or Checkout is
    // temporarily unavailable. There is no "demo" billing mode: partial
    // configuration must never hand out a recurring free allowance.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_STARTER_PRICE_ID: z.string().optional(),
    STRIPE_GROWTH_PRICE_ID: z.string().optional(),
    STRIPE_ENTERPRISE_PRICE_ID: z.string().optional(),
    STRIPE_MINUTE_PACK_PRICE_ID: z.string().optional(),
    // Which Customer Portal feature set to open. Deliberately *not* in
    // STRIPE_PORTAL_REQUIRED_ENV: unset means Stripe's account default, which
    // still lets a customer fix a failing card. Requiring it would 503 the
    // portal — and, because that list is spread into the subscription and
    // top-up lists, would 503 both Checkout entry points too.
    STRIPE_PORTAL_CONFIGURATION_ID: z.string().optional(),
    // Tax collection stays off until the tax registrations are confirmed.
    STRIPE_TAX_ENABLED: BooleanEnvSchema.default(false),
    BILLING_GLOBAL_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(100),
    BILLING_LEASE_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(90),

    // Assumed variable cost per connected minute, used to record a provider cost
    // estimate before the provider reports actual usage. Bounded above zero so a
    // misconfigured deployment cannot silently report infinite margin.
    BILLING_VARIABLE_COST_RESERVE_USD_PER_MINUTE: z.coerce
      .number()
      .positive()
      .max(10)
      .default(0.12),
    // Reconciliation cadence. Defaults to every 15 minutes; each run is bounded
    // by BILLING_RECONCILIATION_BATCH_SIZE so a backlog is drained over several
    // runs instead of one long transaction.
    BILLING_RECONCILIATION_CRON: z
      .string()
      .default('*/15 * * * *')
      .refine((v) => {
        const fields = v.trim().split(/\s+/).length;
        return fields === 5 || fields === 6;
      }, 'BILLING_RECONCILIATION_CRON must be a 5- or 6-field cron expression'),
    BILLING_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    // A call that never reported connection is finalized and its reservation
    // released after this many minutes, so credit is not held indefinitely.
    BILLING_STALE_CALL_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

    // Free-plan monthly credit grant sweep. Runs daily rather than monthly on
    // purpose: the grant is idempotent per organization per calendar month, so a
    // daily pass costs nothing on already-granted months while also giving an
    // organization that signs up mid-month its allowance the same day instead of
    // making it wait for the 1st. Always evaluated in UTC so the month key cannot
    // shift with the host timezone.
    FREE_CREDIT_GRANT_CRON: z
      .string()
      .default('15 0 * * *')
      .refine((v) => {
        const fields = v.trim().split(/\s+/).length;
        return fields === 5 || fields === 6;
      }, 'FREE_CREDIT_GRANT_CRON must be a 5- or 6-field cron expression'),

    LLM_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).default(86400),

    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

    // Chat-to-agent generation. LLM calls are expensive, so generation gets its
    // own (stricter) per-user rate limit on top of the global request limiter.
    AGENT_GEN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    AGENT_GEN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(300),
    AGENT_GEN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
    // A session stuck in 'generating' longer than this is failed by the lazy
    // sweep on the next read, so the UI can offer a retry.
    AGENT_GEN_STALE_AFTER_SECONDS: z.coerce.number().int().min(60).default(180),

    // Optional — metrics.controller.ts already fails closed (401) when it is
    // absent — but a short value is worse than none, so enforce a length when
    // set. Empty string counts as absent: the .env.example entry ships blank.
    METRICS_SCRAPE_TOKEN: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    VOICE_WEBHOOK_SECRET: z.string().optional(),
    WORKERS_ENABLED: BooleanEnvSchema.default(false),

    /**
     * Kill switch for the retention sweep — the only automation in this product
     * that permanently destroys customer data (calls, their recordings and
     * transcripts, the CRM fan-out rows holding contact data and the webhook
     * payloads holding caller numbers).
     *
     * Default false, and a second flag on top of `WORKERS_ENABLED` deliberately,
     * against the "no second feature flag" argument in digest.worker.ts: that
     * argument is about a *dormant feature* nobody notices, and the failure mode
     * here is the inverse. `20260830120000_backfill_call_expires_at` stamps every
     * historical call with its workspace's declared retention, so the first run
     * after this is switched on deletes everything already past that period. The
     * blast radius is an operator decision, not a side effect of enabling
     * background work in general.
     */
    RETENTION_SWEEP_ENABLED: BooleanEnvSchema.default(false),

    // PostHog product analytics. Entirely optional: when the flag is off or the
    // project token is absent the API never constructs a client. Host validation
    // happens only when configuration is resolved so disabled analytics can never
    // block boot because of a stale optional value.
    POSTHOG_ENABLED: BooleanEnvSchema.default(false),
    POSTHOG_PROJECT_TOKEN: z.string().optional(),
    POSTHOG_HOST: z.string().default('https://us.i.posthog.com'),
    // Mirror 4xx responses to error tracking as well as 5xx.
    //
    // Off by default because most 4xx traffic is not a bug: an expired session
    // produces a 401 on every in-flight request, and probing for absent routes
    // produces a steady stream of 404s. Sending those makes real server faults
    // harder to find, not easier. Kept as an env flag so an operator can turn it
    // on temporarily while chasing a client-side integration bug and turn it back
    // off without a code change. 5xx is always captured regardless.
    POSTHOG_CAPTURE_CLIENT_ERRORS: BooleanEnvSchema.default(false),
    APP_VERSION: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .default('dev'),

    // Comma-separated list of allowed origins for CORS (no wildcards in production)
    ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  })
  .superRefine((value, ctx) => {
    if (value.KNOWLEDGE_STORAGE_PROVIDER === 's3' && !value.S3_KNOWLEDGE_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_KNOWLEDGE_BUCKET'],
        message: 'S3_KNOWLEDGE_BUCKET is required when KNOWLEDGE_STORAGE_PROVIDER=s3',
      });
    }
    if (value.NODE_ENV === 'production' && value.ALLOWED_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOWED_ORIGINS'],
        message: 'ALLOWED_ORIGINS must contain at least one explicit origin in production',
      });
    }
    // Supabase Auth has exactly two ways to establish a session's claims, and
    // supabase-auth.service.ts tries them in order: local HS256 verification
    // with SUPABASE_JWT_SECRET, then token introspection against
    // /auth/v1/user with SUPABASE_SERVICE_ROLE_KEY. With neither set,
    // resolveClaims() falls straight through to `return null` and the API
    // rejects every single authenticated request while /health stays green and
    // boot logs stay clean. Same failure shape INTERNAL_API_KEY's `.min(32)`
    // exists to prevent: an unsatisfiable check is a config bug, not a mode.
    // Trimmed: ' ' is truthy, so a whitespace-only credential satisfied a plain
    // presence check and then failed every verification and introspection call.
    if (
      value.NODE_ENV === 'production' &&
      !value.SUPABASE_JWT_SECRET?.trim() &&
      !value.SUPABASE_SERVICE_ROLE_KEY?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_JWT_SECRET'],
        message:
          'One of SUPABASE_JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY is required in production; with neither, every session is rejected',
      });
    }
    if (value.NODE_ENV === 'production' && !value.VOICE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VOICE_WEBHOOK_SECRET'],
        message: 'VOICE_WEBHOOK_SECRET is required in production',
      });
    }
    if (value.NODE_ENV === 'production' && value.VOICE_PROVIDER === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VOICE_PROVIDER'],
        message: 'VOICE_PROVIDER=mock is not allowed in production',
      });
    }
    // A test-mode key in production is a silent revenue outage, not an error:
    // Checkout sessions open and never settle, and live-mode webhook signatures
    // will not verify against a test secret. Nothing else here or in the deploy
    // gate inspects the key's mode and /health cannot see it, so refuse at boot
    // the way VOICE_PROVIDER=mock does above. Restricted keys carry the same
    // mode segment, hence the (sk|rk) alternation.
    if (value.NODE_ENV === 'production' && /^(sk|rk)_test_/.test(value.STRIPE_SECRET_KEY ?? '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_SECRET_KEY'],
        message: 'STRIPE_SECRET_KEY must be a live-mode key in production, not a test-mode key',
      });
    }
    // A deployment that enables the in-house pipeline without complete Azure
    // configuration would accept free-plan calls and then fail once the caller is
    // already connected. Fail at boot naming the missing variable instead.
    if (value.NODE_ENV === 'production' && value.VOICE_STANDARD_PIPELINE_ENABLED) {
      const required = [
        ['AZURE_OPENAI_ENDPOINT', value.AZURE_OPENAI_ENDPOINT],
        ['AZURE_OPENAI_API_KEY', value.AZURE_OPENAI_API_KEY],
        ['AZURE_VOICE_LLM_DEPLOYMENT', value.AZURE_VOICE_LLM_DEPLOYMENT],
        ['AZURE_SPEECH_KEY', value.AZURE_SPEECH_KEY],
        ['AZURE_SPEECH_REGION', value.AZURE_SPEECH_REGION],
      ] as const;
      for (const [name, configured] of required) {
        if (!configured) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required in production when VOICE_STANDARD_PIPELINE_ENABLED=true`,
          });
        }
      }
    }
    // The Azure adapter has no safe default endpoint; require it explicitly in
    // production so a misconfigured deployment fails at boot, not per-request.
    if (
      value.NODE_ENV === 'production' &&
      value.LLM_PROVIDER === 'azure-aifoundry' &&
      !value.LLM_BASE_URL
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LLM_BASE_URL'],
        message: 'LLM_BASE_URL is required in production when LLM_PROVIDER=azure-aifoundry',
      });
    }
    // A Google OAuth client without a redirect URI can mint consent URLs that
    // Google will always reject; fail at boot instead of per-request. In
    // production the URI must be a non-local HTTPS URL; outside production,
    // plain HTTP is allowed for local development loopback addresses only.
    if (value.GOOGLE_CLIENT_ID && value.GOOGLE_CLIENT_SECRET) {
      if (!value.GOOGLE_OAUTH_REDIRECT_URI) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GOOGLE_OAUTH_REDIRECT_URI'],
          message:
            'GOOGLE_OAUTH_REDIRECT_URI is required when GOOGLE_CLIENT_ID and ' +
            'GOOGLE_CLIENT_SECRET are configured',
        });
      } else {
        let parsed: URL | null = null;
        try {
          parsed = new URL(value.GOOGLE_OAUTH_REDIRECT_URI);
        } catch {
          parsed = null;
        }
        const isProduction = value.NODE_ENV === 'production';
        const valid = isProduction
          ? parsed !== null && parsed.protocol === 'https:' && !isLocalHostname(parsed.hostname)
          : parsed !== null && (parsed.protocol === 'https:' || isLocalHostname(parsed.hostname));
        if (!valid) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['GOOGLE_OAUTH_REDIRECT_URI'],
            message:
              'GOOGLE_OAUTH_REDIRECT_URI must be a non-local HTTPS URL in production ' +
              '(plain HTTP on localhost is allowed only outside production)',
          });
        }
      }
    }
    // WEB_BASE_URL is the origin Stripe redirects customers back to after
    // checkout and from the billing portal. It defaults to localhost, so a
    // deployment with working Stripe credentials that omits it takes payments and
    // then bounces the customer to a dead address. That failure is invisible to a
    // boot check, hence this guard.
    //
    // Fires as soon as *either* paying entry point is usable, not only when every
    // variable is set: since these lists were split, a deployment with the
    // subscription prices but no minute-pack price takes real payments, and this
    // guard has to cover it. A deployment with no prices at all cannot charge
    // anyone, so its localhost default stays harmless and boot stays quiet — that
    // is the ordinary local-development configuration.
    if (
      missingStripeEnv(STRIPE_SUBSCRIPTION_REQUIRED_ENV, value).length === 0 ||
      missingStripeEnv(STRIPE_TOPUP_REQUIRED_ENV, value).length === 0
    ) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(value.WEB_BASE_URL);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.protocol !== 'https:' || isLocalHostname(parsed.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEB_BASE_URL'],
          message:
            'WEB_BASE_URL must be an absolute non-local HTTPS URL when Stripe Checkout is ' +
            'configured, because Stripe redirects customers back to it',
        });
      }
    }
  });

/**
 * What each Stripe entry point needs, in one place. These lists are the single
 * source of truth: the refinement above, BillingService's runtime gates, the
 * boot warning below and the deploy workflow's `required[]` list all derive from
 * them, because three hand-maintained copies had already drifted into mirror
 * images of each other — the deploy gate required STRIPE_ENTERPRISE_PRICE_ID and
 * omitted STRIPE_MINUTE_PACK_PRICE_ID while the code required the minute pack
 * and never read enterprise. A deployment could therefore pass every gate and
 * still return 503 from subscription checkout, top-up and the customer portal,
 * with no health check that would notice.
 *
 * They are separate lists because missing configuration must disable only the
 * entry point it actually affects. One unset price ID used to take down all
 * three at once; that is a total revenue outage on a single typo.
 *
 * The portal needs no price, but it does need the webhook secret: a plan change
 * or cancellation a customer makes there reaches us only as a webhook, so an
 * unverifiable webhook feed means those changes silently never apply.
 */
export const STRIPE_PORTAL_REQUIRED_ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const;

export const STRIPE_SUBSCRIPTION_REQUIRED_ENV = [
  ...STRIPE_PORTAL_REQUIRED_ENV,
  'STRIPE_STARTER_PRICE_ID',
  'STRIPE_GROWTH_PRICE_ID',
] as const;

export const STRIPE_TOPUP_REQUIRED_ENV = [
  ...STRIPE_PORTAL_REQUIRED_ENV,
  'STRIPE_MINUTE_PACK_PRICE_ID',
] as const;

/** The union: what a fully live deployment sets, and what the deploy gate checks. */
export const STRIPE_CHECKOUT_REQUIRED_ENV = [
  ...STRIPE_SUBSCRIPTION_REQUIRED_ENV,
  'STRIPE_MINUTE_PACK_PRICE_ID',
] as const;

export type StripeEnvName = (typeof STRIPE_CHECKOUT_REQUIRED_ENV)[number];

/** The names in `required` that `source` does not set, in list order. */
export function missingStripeEnv(
  required: readonly StripeEnvName[],
  source: Partial<Record<StripeEnvName, string | undefined>>,
): StripeEnvName[] {
  return required.filter((name) => !source[name]);
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    // Unspecified bind addresses are not reachable public origins either.
    host === '0.0.0.0' ||
    host === '::' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^127\./.test(host)
  );
}

/**
 * Variables that configured the removed Vapi and Retell runtime adapters.
 * Zod strips unknown keys, so a deployment that still sets them boots normally;
 * this list exists so an operator is told once that they are now inert rather
 * than assuming they still influence call routing.
 */
export const REMOVED_VOICE_ENV_VARS = [
  'VAPI_API_KEY',
  'VAPI_BASE_URL',
  'VAPI_WEBHOOK_SECRET',
  'VAPI_PHONE_NUMBER_ID',
  'RETELL_API_KEY',
  'RETELL_BASE_URL',
  'RETELL_FROM_NUMBER',
  'RETELL_VOICE_ID',
] as const;

/**
 * Returns the removed voice provider variables that are still present in the
 * given environment, so boot can report them without failing. A retired
 * `VOICE_PROVIDER` selection is reported too, because unlike the other keys it
 * is silently rewritten rather than ignored.
 */
export function findRemovedVoiceEnvVars(
  source: Record<string, string | undefined> = process.env,
): string[] {
  const present = REMOVED_VOICE_ENV_VARS.filter((name) => {
    const value = source[name];
    return typeof value === 'string' && value.trim() !== '';
  }) as string[];
  const selected = source.VOICE_PROVIDER?.trim().toLowerCase();
  if (selected && (RETIRED_VOICE_PROVIDERS as readonly string[]).includes(selected)) {
    present.push('VOICE_PROVIDER');
  }
  return present;
}

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

const removedVoiceEnvVars = findRemovedVoiceEnvVars();
if (removedVoiceEnvVars.length > 0) {
  // Emitted once at import time, before Nest's logger exists.
  console.warn(
    `[env] Ignoring removed voice provider configuration: ${removedVoiceEnvVars.join(', ')}. ` +
      'Vapi and Retell are no longer supported; a retired VOICE_PROVIDER value falls back to ' +
      'openai-realtime. Delete these and configure VOICE_STANDARD_PIPELINE_ENABLED with the ' +
      'AZURE_SPEECH_* / AZURE_OPENAI_* variables instead.',
  );
}

/**
 * Nothing else in production reports an incomplete Stripe configuration. Every
 * STRIPE_* field here is optional, /health checks db/redis/llm only, and the
 * first symptom of a missing price ID is a 503 on a paying customer's upgrade
 * click. Name the disabled entry points and the exact variables at boot instead.
 */
if (env.NODE_ENV === 'production') {
  const disabled = (
    [
      ['subscription checkout', STRIPE_SUBSCRIPTION_REQUIRED_ENV],
      ['minute-pack top-up', STRIPE_TOPUP_REQUIRED_ENV],
      ['customer portal', STRIPE_PORTAL_REQUIRED_ENV],
    ] as const
  )
    .map(([label, required]) => [label, missingStripeEnv(required, env)] as const)
    .filter(([, missing]) => missing.length > 0);
  if (disabled.length > 0) {
    console.warn(
      '[env] Stripe is incompletely configured; these actions will return 503: ' +
        `${disabled
          .map(([label, missing]) => `${label} (missing ${missing.join(', ')})`)
          .join('; ')}.`,
    );
  }
}

export function isProduction(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}
