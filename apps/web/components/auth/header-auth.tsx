'use client';

import Link from 'next/link';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

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

  const email = user.email ?? '';
  const initial = email[0]?.toUpperCase() ?? 'U';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-[#e5eee7] hover:bg-white/10 hover:text-white"
        >
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-xs">{initial}</AvatarFallback>
          </Avatar>
          <span className="max-w-[150px] truncate">{email}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>My Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard">Dashboard</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/dashboard/settings">Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
