import 'dotenv/config';
import { z } from 'zod';

const BooleanEnvSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return value;
}, z.boolean());

/**
 * Typed env schema. Keep in sync with the monorepo root `.env.example`.
 * We intentionally load from process.env and validate once at boot so a
 * misconfigured environment fails fast with a readable error.
 *
 * Mock providers are available for credential-less development and tests but
 * are rejected in production.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).optional(),
  WEB_PORT: z.coerce.number().int().min(1).optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  AUTH_PROVIDER: z.enum(['supabase']).default('supabase'),
  VOICE_PROVIDER: z.enum(['mock', 'vapi', 'twilio', 'openai-realtime', 'retell']).optional(),
  LLM_PROVIDER: z.enum(['github', 'openai', 'anthropic', 'azure-aifoundry']).default('anthropic'),
  EMBEDDING_PROVIDER: z.enum(['openai']).default('openai'),

  VAPI_API_KEY: z.string().optional(),
  VAPI_BASE_URL: z.string().default('https://api.vapi.ai'),
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  VAPI_PHONE_NUMBER_ID: z.string().optional(),

  RETELL_API_KEY: z.string().optional(),
  RETELL_BASE_URL: z.string().url().default('https://api.retellai.com'),
  RETELL_FROM_NUMBER: z.string().optional(),
  RETELL_VOICE_ID: z.string().default('11labs-Adrian'),

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
    .refine(
      (v) => {
        const fields = v.trim().split(/\s+/).length;
        return fields === 5 || fields === 6;
      },
      'WEEKLY_DIGEST_CRON must be a 5- or 6-field cron expression',
    ),
  WEEKLY_DIGEST_TIMEZONE: z.string().default('UTC'),

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
  LLM_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_API_VERSION: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),

  JWT_SECRET: z.string().min(32).refine(
    (v) => process.env.NODE_ENV !== 'production' || v !== 'change-me-in-development',
    'JWT_SECRET must be a secure 32+ character string in production',
  ),
  ENCRYPTION_KEY: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_STARTER_PRICE_ID: z.string().optional(),
  STRIPE_GROWTH_PRICE_ID: z.string().optional(),
  STRIPE_ENTERPRISE_PRICE_ID: z.string().optional(),
  BILLING_MODE: z.enum(['demo', 'live']).default('demo'),

  LLM_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).default(86400),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  METRICS_SCRAPE_TOKEN: z.string().optional(),
  VOICE_WEBHOOK_SECRET: z.string().optional(),
  WORKERS_ENABLED: BooleanEnvSchema.default(false),

  // Comma-separated list of allowed origins for CORS (no wildcards in production)
  ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
}).superRefine((value, ctx) => {
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
  // WEB_BASE_URL is the origin Stripe redirects customers back to after
  // checkout and from the billing portal. It defaults to localhost, so a live
  // deployment that omits it takes payments and then bounces the customer to a
  // dead address. That failure is invisible to a boot check, hence this guard.
  if (value.BILLING_MODE === 'live') {
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
          'WEB_BASE_URL must be an absolute non-local HTTPS URL when BILLING_MODE=live, ' +
          'because Stripe redirects customers back to it',
      });
    }
  }
});

function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^127\./.test(host)
  );
}

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

export function isProduction(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}
