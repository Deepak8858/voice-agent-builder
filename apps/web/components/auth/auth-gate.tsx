'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

type AuthGateProps = {
  children: React.ReactNode;
};

/**
 * Reacts to sign-out; it does not gate rendering.
 *
 * Authorization is enforced entirely on the server: `middleware.ts` rejects
 * unauthenticated navigations and the dashboard layout redirects when
 * `/auth/me` returns 401. This component previously repeated that check with a
 * blocking `supabase.auth.getUser()` network round trip and rendered `null`
 * until it resolved, adding a second blank screen on every dashboard mount for
 * a decision the client is not allowed to make anyway.
 *
 * What remains is purely reactive: when Supabase reports a sign-out (including
 * one performed in another tab), drop every cached query so a shared machine
 * cannot show the previous user's data, then send the browser to sign-in.
 */
export function AuthGate({ children }: AuthGateProps) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | null = null;

    try {
      const supabase = createBrowserSupabaseClient();
      subscription = supabase.auth.onAuthStateChange((event) => {
        if (event !== 'SIGNED_OUT') return;
        // The React Query cache lives in browser memory and is per-session,
        // but it survives client-side navigation, so it must be cleared
        // explicitly on sign-out.
        queryClient.clear();
        router.replace(`/sign-in?next=${encodeURIComponent(pathname ?? '/dashboard')}`);
      }).data.subscription;
    } catch {
      // A degraded Supabase client must not break the dashboard; the server
      // remains the enforcement point.
    }

    return () => {
      subscription?.unsubscribe();
    };
  }, [pathname, queryClient, router]);

  return <>{children}</>;
}
