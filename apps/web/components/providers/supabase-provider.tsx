'use client';

import { createClient } from '@supabase/supabase-js';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

function getEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Set both in .env',
    );
  }
  return { url, key };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SupabaseContext = createContext<any>(null);

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const { url, key } = getEnv();
  const [supabase] = useState(() =>
    createClient(url, key, {
      auth: {
        autoRefreshToken: true,
        persistSession: false,
        detectSessionInUrl: true,
      },
    }),
  );

  return (
    <SupabaseContext.Provider value={supabase}>
      {children}
    </SupabaseContext.Provider>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useSupabase(): any {
  const ctx = useContext(SupabaseContext);
  if (!ctx) throw new Error('useSupabase must be used within SupabaseProvider');
  return ctx;
}

export function SupabaseAuthStatus() {
  const supabase = useSupabase();
  const router = useRouter();
  const [session, setSession] = useState<{ user?: { id?: string } } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }: { data: { session: { user?: { id?: string } } | null } }) => setSession(data.session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: string, session: { user?: { id?: string } } | null) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  if (session?.user) {
    return (
      <>
        <Link
          href="/dashboard"
          className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          Dashboard
        </Link>
        <button
          onClick={() => supabase.auth.signOut().then(() => router.push('/'))}
          className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          Sign out
        </button>
      </>
    );
  }

  return (
    <>
      <Link href="/sign-in">
        <Button variant="ghost" size="sm">
          Sign in
        </Button>
      </Link>
      <Link href="/sign-up">
        <Button size="sm">
          Sign up
        </Button>
      </Link>
    </>
  );
}