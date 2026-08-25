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
    LIVEKIT_WEBHOOK_SECRET: z.string().optional(),
    LIVEKIT_ROOM_PREFIX: z.string().default('call'),
    LIVEKIT_AGENT_NAME: z.string().default('voiceforge-agent'),
    LIVEKIT_AGENT_NAME_PREFIX: z.string().default('voiceforge-agent'),
    VOBIZ_WEBHOOK_SECRET: z.string().optional(),
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
    SUPABASE_URL: z.string().optional(),
    SUPABASE_JWT_SECRET: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_KNOWLEDGE_BUCKET: z.string().min(1).optional(),
    SUPABASE_STORAGE_BUCKET: z.string().min(1).optional(),

    // Shared secret between Next.js frontend and this NestJS API. The
    // frontend is the only legitimate caller; it forwards the Supabase
    // bearer token and the API derives user context server-side.
    INTERNAL_API_KEY: z.string().min(32).optional(),

    GITHUB_TOKEN: z.string().optional(),
    LLM_MODEL: z.string().optional(),
    LLM_BASE_URL: OptionalUrlEnvSchema,
    OPENAI_API_KEY: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_API_VERSION: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().optional(),

    JWT_SECRET: z
      .string()
      .min(32)
      .refine(
        (v) => process.env.NODE_ENV !== 'production' || v !== 'change-me-in-development',
        'JWT_SECRET must be a secure 32+ character string in production',
      ),
    ENCRYPTION_KEY: z.string().optional(),

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

    METRICS_SCRAPE_TOKEN: z.string().optional(),
    VOICE_WEBHOOK_SECRET: z.string().optional(),
    WORKERS_ENABLED: BooleanEnvSchema.default(false),

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
    if (isStripeCheckoutConfigured(value)) {
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
 * Checkout is only usable when every server-owned identifier is present. A
 * partially configured deployment fails closed rather than sending a customer
 * to Stripe and then being unable to grant what they paid for.
 */
function isStripeCheckoutConfigured(value: {
  STRIPE_SECRET_KEY?: string | undefined;
  STRIPE_WEBHOOK_SECRET?: string | undefined;
  STRIPE_STARTER_PRICE_ID?: string | undefined;
  STRIPE_GROWTH_PRICE_ID?: string | undefined;
  STRIPE_MINUTE_PACK_PRICE_ID?: string | undefined;
}): boolean {
  return Boolean(
    value.STRIPE_SECRET_KEY &&
    value.STRIPE_WEBHOOK_SECRET &&
    value.STRIPE_STARTER_PRICE_ID &&
    value.STRIPE_GROWTH_PRICE_ID &&
    value.STRIPE_MINUTE_PACK_PRICE_ID,
  );
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

export function isProduction(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}
