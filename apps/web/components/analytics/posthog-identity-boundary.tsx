'use client';

import { useEffect } from 'react';
import { resetIdentityIfIdentified } from '@/lib/analytics/posthog';

/**
 * Clears a stale PostHog identity on the unauthenticated pages. Renders nothing.
 *
 * `PostHogIdentityBridge` can only observe a client-side Supabase `SIGNED_OUT`
 * event. A session that expires or is revoked server-side never produces one:
 * `/auth/me` returns 401 and the dashboard layout redirects, `AuthGate` replaces
 * the route, or onboarding pushes to sign-in. In all three cases the bridge is
 * unmounted without ever resetting, so the browser SDK keeps the former user's
 * distinct ID.
 *
 * Placing the reset on the destination rather than on each redirect site means
 * a new auth-loss path cannot silently miss it, and it is the correct assertion
 * to make there: whoever is looking at the sign-in page is not the person the
 * SDK is currently identified as.
 */
export function PostHogIdentityBoundary() {
  useEffect(() => {
    resetIdentityIfIdentified();
  }, []);

  return null;
}
