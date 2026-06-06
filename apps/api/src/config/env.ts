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
 * RULE: mock providers are REMOVED. Only real providers are allowed.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).optional(),
  WEB_PORT: z.coerce.number().int().min(1).optional(),

  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  AUTH_PROVIDER: z.enum(['supabase']).default('supabase'),
  VOICE_PROVIDER: z.enum(['vapi', 'twilio', 'openai-realtime']).optional(),
  LLM_PROVIDER: z.enum(['github', 'openai', 'anthropic', 'azure-aifoundry']).default('anthropic'),
  EMBEDDING_PROVIDER: z.enum(['openai']).default('openai'),

  VAPI_API_KEY: z.string().optional(),
  VAPI_BASE_URL: z.string().default('https://api.vapi.ai'),
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  VAPI_PHONE_NUMBER_ID: z.string().optional(),

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
  if (value.NODE_ENV === 'production' && !value.VOICE_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VOICE_WEBHOOK_SECRET'],
      message: 'VOICE_WEBHOOK_SECRET is required in production',
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

export function isProduction(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}
