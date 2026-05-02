'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { useApi } from '@/lib/use-api';

function InviteAcceptInner() {
  const { call } = useApi();
  const token = useSearchParams().get('token');

  useEffect(() => {
    if (!token) return;
    call<{ status: string }>('/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }).then(() => {
      setTimeout(() => { window.location.href = '/dashboard'; }, 800);
    }).catch(() => {
      window.location.href = '/sign-in';
    });
  }, [token]);

  return (
    <div className="flex h-screen items-center justify-center">
      <p>Accepting invite…</p>
    </div>
  );
}

export default function InviteAcceptPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center"><p>Loading…</p></div>}>
      <InviteAcceptInner />
    </Suspense>
  );
}