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

/** Resolve an origin-only HTTPS host without letting analytics block boot. */
function resolveHost(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' || parsed.origin !== raw.trim().replace(/\/$/, '')) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Reads PostHog settings from the validated env. Returns `null` — meaning
 * "fully disabled" — when the flag is off, the token is absent, or the optional
 * host is malformed. Analytics configuration is never fatal.
 */
export function posthogConfigFromEnv(): PostHogConfig | null {
  if (!env.POSTHOG_ENABLED) return null;
  const projectToken = env.POSTHOG_PROJECT_TOKEN?.trim();
  const host = resolveHost(env.POSTHOG_HOST);
  if (!projectToken || !host) return null;
  return {
    projectToken,
    host,
    environment: env.NODE_ENV,
    release: env.APP_VERSION,
  };
}
