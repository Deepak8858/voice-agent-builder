'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Logo } from '@/components/logo';

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();
  const [orgName, setOrgName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    const appUserId = user.user_metadata?.app_user_id;
    if (!appUserId) {
      setError('User profile not found. Please sign out and sign in again.');
      setLoading(false);
      return;
    }

    try {
      const adminClient = createSupabaseAdminClient();

      // Create organization
      const { data: org, error: orgError } = await adminClient
        .from('organizations')
        .insert({
          name: orgName,
          created_by_user_id: appUserId,
        })
        .select('id')
        .single();

      if (orgError) throw orgError;

      // Create default workspace
      const { data: workspace, error: wsError } = await adminClient
        .from('workspaces')
        .insert({
          name: workspaceName || 'My Workspace',
          organization_id: org.id,
        })
        .select('id')
        .single();

      if (wsError) throw wsError;

      // Create owner membership
      const { error: memberError } = await adminClient
        .from('memberships')
        .insert({
          user_id: appUserId,
          workspace_id: workspace.id,
          role: 'owner',
        });

      if (memberError) throw memberError;

      // Update user JWT app_metadata with active org
      await adminClient.auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, active_org_id: org.id },
        app_metadata: {
          ...user.app_metadata,
          active_org_id: org.id,
          active_org_role: 'owner',
        },
      });

      // Sign out to refresh cookies with new metadata
      await supabase.auth.signOut();
      router.push('/dashboard');
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