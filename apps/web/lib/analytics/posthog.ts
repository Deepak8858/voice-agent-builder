'use client';

import posthog from 'posthog-js';
import { buildPostHogEvent, buildGroups, userIdentity } from '@voiceforge/shared';

/**
 * The only supported way for browser code to talk to PostHog.
 *
 * Nothing here throws and nothing here awaits: analytics must never delay or
 * break a product flow. Every function is a no-op when the SDK was not
 * initialised (`instrumentation-client.ts` skips `init` unless the kill switch
 * and a project token are both set), so the absence of PostHog config is a
 * fully supported runtime state rather than a degraded one.
 */

/** The workspace group type. Must match the API's `$groups.workspace`. */
const WORKSPACE_GROUP_TYPE = 'workspace';

function isReady(): boolean {
  return typeof window !== 'undefined' && posthog.__loaded;
}

export interface IdentifyInput {
  /** App user ID from `/auth/me` — the same ID the API uses as distinct ID. */
  userId: string;
  /** Trusted active workspace ID from the session, or null when unset. */
  workspaceId: string | null;
}

/**
 * Binds the current browser session to the authenticated user and workspace.
 *
 * Identity is taken from the server-rendered session rather than from anything
 * the browser can derive, so web and API events land on the same person. When
 * the identified user changes (account switch on a shared device), the previous
 * identity is reset first: `identify()` alone would alias the two users
 * together and silently corrupt every per-user metric.
 *
 * Organization grouping is intentionally absent. The session contract carries
 * no trusted organization ID, and inferring one in the browser would attribute
 * events to a tenant on the strength of a client-side guess. The API attaches
 * `$groups.organization` where it can resolve it server-side.
 */
export function identifyUser({ userId, workspaceId }: IdentifyInput): void {
  if (!isReady()) return;

  try {
    const identity = userIdentity(userId);
    if (!identity) return;

    const current = posthog.get_distinct_id();
    if (current && current !== identity.distinctId) {
      // Different user on the same device: break the anonymous->identified
      // chain before claiming the new ID.
      posthog.reset();
    }

    // No person properties: email and name are not sent to PostHog.
    posthog.identify(identity.distinctId);

    if (workspaceId) {
      const groups = buildGroups({ workspaceId });
      const workspaceGroup = groups?.[WORKSPACE_GROUP_TYPE];
      if (workspaceGroup) posthog.group(WORKSPACE_GROUP_TYPE, workspaceGroup);
    }
  } catch {
    // ignore: analytics failures never surface to the product
  }
}

/**
 * Clears the identity on logout or auth loss.
 *
 * Without this the next visitor on the device inherits the previous user's
 * distinct ID, which merges two real people into one person profile.
 */
export function resetIdentity(): void {
  if (!isReady()) return;
  try {
    posthog.reset();
  } catch {
    // ignore
  }
}

/**
 * Clears the identity only if one is currently bound.
 *
 * Used on the unauthenticated pages, which are the common landing point for
 * every auth-loss path — an expired or revoked session redirects there from the
 * server, from `AuthGate`, or from onboarding, and none of those unmount paths
 * runs a Supabase `SIGNED_OUT` event. Without a reset here the browser keeps
 * the previous user's distinct ID and attributes every later pageview,
 * including the next person to sign in on the device, to them.
 *
 * The guard matters: an unconditional reset on each visit would mint a fresh
 * anonymous ID every time a signed-out visitor loads the sign-in page, breaking
 * the pre-signup funnel. `$user_id` is registered by `identify()` and cleared by
 * `reset()`, so its presence is exactly "an identity is bound".
 */
export function resetIdentityIfIdentified(): void {
  if (!isReady()) return;
  try {
    if (!posthog.get_property('$user_id')) return;
    posthog.reset();
  } catch {
    // ignore
  }
}

/**
 * Captures a funnel event from the browser.
 *
 * The name and properties are re-validated through the shared Phase 1 contract,
 * so an unknown event or an unexpected property is dropped here rather than
 * sent and cleaned up later. Callers must invoke this only after the server has
 * confirmed the action succeeded — never from a click handler — so the event
 * means "this happened", not "this was attempted".
 *
 * Events the API already emits authoritatively (`agent_created`,
 * `agent_published`, `workspace_created`, `user_signed_up`) must not be sent
 * from here: the server owns the authoritative IDs and duplicating them would
 * double-count every conversion.
 */
export function captureFunnelEvent(
  event: string,
  properties?: Record<string, unknown> | null,
): void {
  if (!isReady()) return;

  try {
    const sanitized = buildPostHogEvent({ event, properties });
    if (!sanitized) return;
    posthog.capture(sanitized.event, sanitized.properties);
  } catch {
    // ignore
  }
}
