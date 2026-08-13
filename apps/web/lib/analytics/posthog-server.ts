import 'server-only';
import { buildPostHogCapture, type PostHogCaptureContext } from '@voiceforge/shared';
import { resolvePostHogHost } from './posthog-config';

/**
 * Server-side PostHog capture for Next.js route handlers.
 *
 * `posthog-node` is deliberately not used here. It buffers events and relies on
 * an explicit `shutdown()`/`flush()` to deliver them; a route handler has no
 * lifecycle hook to call one, so buffered events would be lost whenever the
 * server instance is recycled. A single awaited request is both simpler and
 * strictly more reliable for the handful of low-volume conversion events the
 * web tier emits. The API service, which is long-lived and has a shutdown hook,
 * keeps using the SDK.
 *
 * The privacy boundary is the same one the browser and the API use:
 * `buildPostHogCapture` validates the event against the closed contract, binds
 * identity per `EVENT_IDENTITY_KIND`, and returns `null` for anything unsafe.
 *
 * Nothing here throws. Analytics must never turn a successful onboarding into a
 * failed request.
 *
 * Unlike the browser, this module talks to PostHog directly rather than through
 * `/vf-relay`. The proxy exists to keep browser traffic same-origin; CSP and ad
 * blockers do not apply to a server-side fetch, and routing through the app's
 * own origin would only add a hop.
 */

/** Upper bound on the capture request. Latency beats event delivery. */
const CAPTURE_TIMEOUT_MS = 2_000;

interface ServerPostHogConfig {
  projectToken: string;
  host: string;
}

/**
 * Reads the server-side (non-`NEXT_PUBLIC_`) PostHog settings.
 *
 * Uses `POSTHOG_ENABLED` rather than the browser kill switch: this emitter runs
 * in the same trust domain as the API, and the two switches are independent by
 * design so browser capture can be disabled without losing server-side
 * conversion events.
 */
function serverConfig(): ServerPostHogConfig | null {
  if (process.env.POSTHOG_ENABLED !== 'true') return null;

  const projectToken = process.env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!projectToken) return null;

  // Same normalizer the browser settings and the proxy rewrites use, so there
  // is exactly one definition of a valid host. Never strict: a bad value must
  // degrade analytics, not fail an onboarding request.
  const host = resolvePostHogHost(process.env.POSTHOG_HOST, {
    strict: false,
    envVar: 'POSTHOG_HOST',
  });

  return { projectToken, host };
}

/**
 * Sends one contract event. Resolves once the request settles or the timeout
 * elapses, and always resolves successfully.
 *
 * Callers must await this only after every write the event describes has
 * committed, so the event means "this happened" rather than "this was
 * attempted".
 */
export async function captureServerEvent(
  event: string,
  properties: Record<string, unknown> | null,
  context: PostHogCaptureContext,
): Promise<void> {
  const config = serverConfig();
  if (!config) return;

  const capture = buildPostHogCapture({ event, properties, context });
  if (!capture) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);

  try {
    await fetch(`${config.host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      // Never let a capture keep a serverless invocation alive.
      keepalive: false,
      cache: 'no-store',
      body: JSON.stringify({
        api_key: config.projectToken,
        event: capture.event,
        distinct_id: capture.distinctId,
        timestamp: new Date().toISOString(),
        properties: {
          ...capture.properties,
          $groups: capture.groups,
          ...(capture.processPersonProfile ? {} : { $process_person_profile: false }),
          // The server's egress IP is not the user's location.
          $geoip_disable: true,
        },
      }),
    });
  } catch {
    // Timed out, aborted or network failure: analytics is best-effort.
  } finally {
    clearTimeout(timer);
  }
}
