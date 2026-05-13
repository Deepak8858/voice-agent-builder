import { z } from 'zod';

export const envSchema = z.object({
  REDIS_URL: z.string(),
  DEEPGRAM_API_KEY: z.string(),
  ANTHROPIC_API_KEY: z.string(),
  CARTESIA_API_KEY: z.string(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
});

export type Env = z.infer<typeof envSchema>;