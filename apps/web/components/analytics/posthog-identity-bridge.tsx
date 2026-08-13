'use client';

import { useEffect } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import { identifyUser, resetIdentity } from '@/lib/analytics/posthog';

type PostHogIdentityBridgeProps = {
  /** App user ID resolved server-side from `/auth/me`. */
  userId: string;
  /** Active workspace ID from the same trusted session payload. */
  workspaceId: string | null;
};

/**
 * Bridges the server-resolved session onto the PostHog browser SDK.
 *
 * Rendered only inside the authenticated dashboard, and given only the two IDs
 * it needs — never the email, name or workspace name that also live on
 * `SessionUser`. Renders nothing.
 *
 * `components/providers/supabase-provider.tsx` is deliberately not used as the
 * identity source: it is currently unused by the app, and a client-side auth
 * lookup is a weaker source of truth than the session the server already
 * validated.
 */
export function PostHogIdentityBridge({ userId, workspaceId }: PostHogIdentityBridgeProps) {
  useEffect(() => {
    identifyUser({ userId, workspaceId });
  }, [userId, workspaceId]);

  useEffect(() => {
    // Sign-out is a client-side Supabase call, so the identity must be cleared
    // here rather than on a server round-trip that may never happen.
    let subscription: { unsubscribe: () => void } | undefined;
    try {
      const supabase = createBrowserSupabaseClient();
      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') resetIdentity();
      });
      subscription = data.subscription;
    } catch {
      // Supabase env missing: nothing to observe, and analytics stays a no-op.
    }
    return () => subscription?.unsubscribe();
  }, []);

  return null;
}
