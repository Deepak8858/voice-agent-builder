'use client';
import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);

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
