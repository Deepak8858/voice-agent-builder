'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import { useApi } from '@/lib/use-api';
import { User, ClipboardList } from 'lucide-react';

/**
 * The Team tab used to live here and fetched `GET /workspaces/:id/members`, a
 * route the API does not define (S-036). The proxy 404 was swallowed by the
 * `.catch(console.error)`, so the tab rendered "No team members found" for every
 * workspace, including ones with members — worse than not offering it. Both the
 * call and the tab are gone; a real members endpoint is a feature, not a fix.
 */
type Tab = 'general' | 'audit';

interface MeResponse {
  id: string;
  active_workspace_id?: string | null;
  active_workspace_name?: string | null;
  active_workspace_role?: string | null;
  workspaces?: Array<{ id: string; name: string; role: string }>;
}

interface AuditLog {
  id: string;
  action: string;
  createdAt: string;
  /** The API includes this as `actor`; reading `user` showed "System" for every row. */
  actor: { email: string; name: string | null } | null;
  metadata: Record<string, unknown> | null;
}

export function SettingsPanel() {
  const { call } = useApi();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // The API returns a refusal (success: false + reason) instead of deleting
  // when the account's organization has other members, retained billing
  // records, or a live subscription — surface that reason, don't retry.
  async function handleDeleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await call<{ success: boolean; error?: string }>('/users/me/erasure', {
        method: 'DELETE',
      });
      if (!result.success) {
        setDeleteError(result.error ?? 'Account deletion was refused.');
        return;
      }
      try {
        await createBrowserSupabaseClient().auth.signOut();
      } catch {
        // The account is gone; a failed sign-out only leaves a dead session.
      }
      router.push('/');
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Account deletion failed.');
    } finally {
      setDeleting(false);
    }
  }

  const currentWorkspaceId = me?.active_workspace_id ?? me?.workspaces?.[0]?.id;
  // The API restricts audit-log reads to owners and admins, so offering the tab
  // to anyone else is a tab that can only 403.
  const canReadAuditLog =
    me?.active_workspace_role === 'owner' || me?.active_workspace_role === 'admin';

  useEffect(() => {
    call<MeResponse>('/auth/me').then(setMe).catch(console.error);
  }, [call]);

  useEffect(() => {
    if (activeTab === 'audit' && currentWorkspaceId && canReadAuditLog) {
      setLoading(true);
      call<{ items: AuditLog[] }>(`/workspaces/${currentWorkspaceId}/audit-logs`)
        .then((res) => setAuditLogs(res.items))
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [activeTab, currentWorkspaceId, canReadAuditLog, call]);

  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)} className="w-full">
      <TabsList>
        <TabsTrigger value="general" className="gap-1.5">
          <User className="h-3.5 w-3.5" />
          General
        </TabsTrigger>
        {canReadAuditLog && (
          <TabsTrigger value="audit" className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
            Audit
          </TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="general" className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Account Information</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between py-2 border-b border-border">
              <span className="text-sm text-muted-foreground">User ID</span>
              <span className="text-sm font-mono text-foreground">{me?.id ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">Workspaces</span>
              <span className="text-sm font-medium text-foreground">
                {me?.active_workspace_id ? 1 : (me?.workspaces?.length ?? 0)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6 border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">Delete account</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Permanently deletes your account and, if you are its only member, your
              organization with all of its workspaces, agents, calls, and recordings.
              This cannot be undone. Accounts with billing history or an active
              subscription cannot be deleted automatically — contact{' '}
              <a href="mailto:privacy@incfrog.ai" className="underline">privacy@incfrog.ai</a>.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder='Type "DELETE" to confirm'
                className="max-w-56"
                aria-label="Type DELETE to confirm account deletion"
              />
              <Button
                variant="destructive"
                disabled={deleteConfirm !== 'DELETE' || deleting}
                onClick={handleDeleteAccount}
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </Button>
            </div>
            {deleteError && (
              <p className="text-sm text-destructive" role="alert">
                {deleteError}
              </p>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="audit" className="mt-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading audit logs…</p>
        ) : auditLogs.length === 0 ? (
          <Card className="py-12 text-center">
            <CardDescription className="text-muted-foreground">No audit logs found.</CardDescription>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {auditLogs.map((log) => (
              <Card key={log.id}>
                <CardContent className="py-4 flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">{log.action}</span>
                    <span className="text-xs text-muted-foreground">
                      {log.actor?.name ?? log.actor?.email ?? 'System'} &middot;{' '}
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

import { CardDescription } from '@/components/ui/card';
