import 'dotenv/config';
import { z } from 'zod';

/**
 * Typed env schema. Keep in sync with the monorepo root `.env.example`.
 * We intentionally load from process.env and validate once at boot so a
 * misconfigured environment fails fast with a readable error.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  AUTH_PROVIDER: z.enum(['mock', 'clerk']).default('mock'),
  VOICE_PROVIDER: z.enum(['mock', 'vapi', 'retell']).default('mock'),
  LLM_PROVIDER: z.enum(['mock', 'github', 'openai', 'anthropic']).default('mock'),
  EMBEDDING_PROVIDER: z.enum(['mock', 'openai']).default('mock'),

  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  JWT_SECRET: z.string().default('change-me-in-development'),
  ENCRYPTION_KEY: z.string().optional(),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

export function isProduction(): boolean {
  return env.NODE_ENV === 'production';
}
