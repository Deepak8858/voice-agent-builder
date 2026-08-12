'use client';

import { useEffect, useRef } from 'react';
import posthog from 'posthog-js';
import { SiteHeader } from '@/components/site-header';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

type AuthUser = {
  id: string;
  email?: string;
};

export function ClientChrome() {
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let subscription: ReturnType<
      ReturnType<typeof createBrowserSupabaseClient>['auth']['onAuthStateChange']
    >['data']['subscription'] | null = null;

    try {
      const supabase = createBrowserSupabaseClient();

      const identifyUser = (user: AuthUser | null) => {
        if (!user) return;

        if (identifiedUserId.current && identifiedUserId.current !== user.id) {
          posthog.reset();
        }

        posthog.identify(user.id, user.email ? { email: user.email } : undefined);
        identifiedUserId.current = user.id;
      };

      void supabase.auth.getUser().then(({ data }) => {
        if (!cancelled) identifyUser(data.user);
      });

      subscription = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          posthog.reset();
          identifiedUserId.current = null;
          return;
        }

        identifyUser(session?.user ?? null);
      }).data.subscription;
    } catch {}

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, []);

  return <SiteHeader />;
}
