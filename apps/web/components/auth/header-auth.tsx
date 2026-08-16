'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Loaded only once a session is confirmed.
 *
 * The account dropdown is the sole consumer of the Radix dropdown/avatar
 * primitives on public pages. Importing it statically shipped that code to
 * every signed-out visitor on the landing page, which is the largest single
 * chunk in that route's first load. `ssr: false` is correct here: the menu only
 * renders after a client-side Supabase session check, so it never exists in the
 * server-rendered HTML anyway.
 */
const UserMenu = dynamic(
  () => import('@/components/auth/user-menu').then((m) => m.UserMenu),
  { ssr: false, loading: () => <div className="h-9 w-20 animate-pulse rounded-md bg-white/10" /> },
);

export function HeaderAuth() {
  const router = useRouter();
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    try {
      const supabase = createBrowserSupabaseClient();
      void supabase.auth.getUser().then(({ data }) => {
        if (!cancelled) {
          setUser(data.user);
          setLoading(false);
        }
      });
    } catch {
      if (!cancelled) {
        setUser(null);
        setLoading(false);
      }
    }
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignOut() {
    try {
      const supabase = createBrowserSupabaseClient();
      await supabase.auth.signOut();
    } catch {
      // ignore sign-out failures during degraded client init
    }
    router.push('/');
    router.refresh();
  }

  if (loading) {
    return <div className="h-9 w-20 animate-pulse rounded-md bg-white/10" />;
  }

  if (!user) {
    return (
      <>
        <Link href="/sign-in">
          <Button
            variant="ghost"
            size="sm"
            className="text-[#e5eee7] hover:bg-white/10 hover:text-white"
          >
            Sign in
          </Button>
        </Link>
        <Link href="/sign-up">
          <Button
            size="sm"
            className="bg-[#bfff4a] text-[#07130f] shadow-sm shadow-[#bfff4a]/15 hover:bg-[#d9ff8a]"
          >
            Sign up
          </Button>
        </Link>
      </>
    );
  }

  return <UserMenu email={user.email ?? ''} onSignOut={handleSignOut} />;
}
