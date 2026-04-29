import pino from 'pino';

/**
 * Pino logger factory for VoiceForge API.
 *
 * In production (NODE_ENV=production) logs JSON lines to stdout.
 * In development logs human-readable pino-pretty format.
 *
 * Add ` pinopretty` to your dev start script to get colourised output locally, e.g.:
 *   npm run dev | npx pino-pretty
 *
 * To use in a service:
 *   const log = logger.child({ module: 'MyService' });
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Unix epoch ms — standard for production JSON log pipelines (Loki, ELK, CloudWatch)
  timestamp: pino.stdTimeFunctions.unixTime,
});