import { env } from '../config/env';

/**
 * Resolved PostHog configuration. The service only ever constructs a client
 * when this is non-null, so an unset `POSTHOG_ENABLED` or missing project
 * token makes the whole integration inert rather than degraded.
 */
export interface PostHogConfig {
  projectToken: string;
  host: string;
  /** Deployment environment, registered as a super property. */
  environment: string;
  /** Release/build identifier, registered as a super property. */
  release: string;
}

/**
 * Reads PostHog settings from the validated env. Returns `null` — meaning
 * "fully disabled" — when the flag is off or the token is absent. Absent
 * configuration is never fatal.
 */
export function posthogConfigFromEnv(): PostHogConfig | null {
  if (!env.POSTHOG_ENABLED) return null;
  const projectToken = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!projectToken) return null;
  return {
    projectToken,
    host: env.POSTHOG_HOST,
    environment: env.NODE_ENV,
    release: process.env.APP_VERSION ?? 'dev',
  };
}
