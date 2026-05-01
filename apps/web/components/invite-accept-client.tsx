'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/use-api';

interface AcceptResult {
  client_workspace_id?: string | null;
  status?: string;
}

export function InviteAcceptClient({ token }: { token: string }) {
  const { call } = useApi();
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function accept() {
      setState('pending');
      try {
        const res = await call<AcceptResult>(`/invites/accept`, {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        setState('done');
        const target = res.client_workspace_id
          ? `/dashboard`
          : '/dashboard';
        setTimeout(() => router.push(target), 800);
      } catch (err) {
        if (cancelled) return;
        setState('error');
        setError((err as Error).message);
      }
    }
    accept();
    return () => {
      cancelled = true;
    };
  }, [call, router, token]);

  if (state === 'pending' || state === 'idle') {
    return (
      <>
        <h1 className="text-xl font-semibold">Accepting invitation…</h1>
        <p className="text-sm text-zinc-500">Setting up your workspace.</p>
      </>
    );
  }

  if (state === 'done') {
    return (
      <>
        <h1 className="text-xl font-semibold">You're in.</h1>
        <p className="text-sm text-zinc-500">Redirecting to your dashboard…</p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Could not accept invite</h1>
      <p className="text-sm text-red-600">{error}</p>
      <Button onClick={() => router.push('/dashboard')}>Go to dashboard</Button>
    </>
  );
}
