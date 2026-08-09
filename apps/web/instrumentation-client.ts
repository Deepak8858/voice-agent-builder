import posthog from 'posthog-js';
import {
  posthogInitOptions,
  posthogSuperProperties,
  posthogWebSettingsFromEnv,
} from '@/lib/analytics/posthog-config';

/**
 * Client instrumentation hook, run once by Next.js before the app hydrates.
 *
 * `instrumentation-client.ts` is the current stable PostHog recommendation for
 * the Next.js App Router; the pre-release `@posthog/next` package is
 * deliberately not used.
 *
 * Initialisation is a no-op unless the kill switch is on AND a project token is
 * present. When it is a no-op, `posthog.__loaded` stays false and every capture
 * helper in `lib/analytics/posthog.ts` short-circuits, so no request is ever
 * made and nothing in the product depends on analytics being available.
 *
 * `process.env.NEXT_PUBLIC_*` is read through explicit member expressions
 * because Next.js inlines these at build time by literal substitution; a
 * computed or spread access would not be replaced and would be `undefined` in
 * the browser.
 */
const settings = posthogWebSettingsFromEnv({
  NEXT_PUBLIC_POSTHOG_ENABLED: process.env.NEXT_PUBLIC_POSTHOG_ENABLED,
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
  NODE_ENV: process.env.NODE_ENV,
});

if (settings) {
  try {
    posthog.init(settings.projectToken, {
      ...posthogInitOptions(settings),
      loaded: (instance) => {
        // Release metadata only — never user data.
        instance.register(posthogSuperProperties(settings));
      },
    });
  } catch {
    // Analytics must never break page load. A failed init leaves the SDK
    // unloaded, which the capture helpers already treat as "drop".
  }
}
