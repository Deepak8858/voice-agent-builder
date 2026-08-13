import posthog from 'posthog-js';
import {
  posthogInitOptions,
  posthogSuperProperties,
  posthogWebSettingsFromEnv,
} from '@/lib/analytics/posthog-config';

/**
 * Client instrumentation hook, run once by Next.js before the app hydrates.
 *
 * Initialisation is a no-op unless the browser kill switch is on and its
 * project token is present. Explicit environment reads are required because
 * Next.js substitutes NEXT_PUBLIC_* values into the bundle at build time.
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
    // Analytics must never break page load.
  }
}
