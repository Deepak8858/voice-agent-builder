'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

type AuthGateProps = {
  children: React.ReactNode;
  fallback?: React.ReactNode;
};

export function AuthGate({ children, fallback }: AuthGateProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createBrowserSupabaseClient();
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setAuthed(!!data.user);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (checking) {
    return fallback ?? null;
  }

  if (!authed) {
    router.replace(`/sign-in?next=${encodeURIComponent(pathname ?? '/dashboard')}`);
    return fallback ?? null;
  }

  return <>{children}</>;
}
