'use client';

import Link from 'next/link';
import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Logo } from '@/components/logo';
import posthog from 'posthog-js';

function sanitizeNext(next: string | null): string {
  if (!next) return '/dashboard';
  if (!next.startsWith('/') || next.startsWith('//')) return '/dashboard';
  if (next.includes('\\')) return '/dashboard';
  return next;
}

function OnboardingInner() {
  const router = useRouter();
  const search = useSearchParams();
  const supabase = createBrowserSupabaseClient();
  const [orgName, setOrgName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = useMemo(() => sanitizeNext(search?.get('next') ?? null), [search]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      router.push('/sign-in');
      return;
    }

    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgName,
          workspaceName,
        }),
      });

      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `Onboarding failed (${res.status})`);

      await supabase.auth.refreshSession();
      posthog.capture('onboarding_completed');
      router.push(next);
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create organization';
      setError(message);
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link href="/" className="inline-flex items-center gap-2 font-semibold mb-8">
            <Logo size={28} />
            <span className="font-serif text-2xl">VoiceForge</span>
          </Link>
          <h1 className="text-2xl font-semibold">Create your organization</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Set up your organization and workspace to get started
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="orgName">Organization name</Label>
            <Input
              id="orgName"
              type="text"
              placeholder="My Company"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workspaceName">Workspace name (optional)</Label>
            <Input
              id="workspaceName"
              type="text"
              placeholder="Production"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              You can create more workspaces later
            </p>
          </div>
          <Button type="submit" className="w-full" loading={loading}>
            Create organization
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <OnboardingInner />
    </Suspense>
  );
}
