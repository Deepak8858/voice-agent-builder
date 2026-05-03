'use client';
import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/use-api';
import { User, Users, ClipboardList } from 'lucide-react';

type Tab = 'general' | 'team' | 'audit';

interface MeResponse {
  id: string;
  workspaces: Array<{ id: string; name: string; role: string }>;
}

interface Member {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
}

interface AuditLog {
  id: string;
  action: string;
  createdAt: string;
  user: { email: string; name: string | null } | null;
  metadata: Record<string, unknown> | null;
}

export function SettingsPanel() {
  const { call } = useApi();
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);

  const currentWorkspaceId = me?.workspaces[0]?.id;

  useEffect(() => {
    call<MeResponse>('/auth/me').then(setMe).catch(console.error);
  }, [call]);

  useEffect(() => {
    if (activeTab === 'team' && currentWorkspaceId) {
      setLoading(true);
      call<{ items: Member[] }>(`/workspaces/${currentWorkspaceId}/members`)
        .then((res) => setMembers(res.items))
        .catch(console.error)
        .finally(() => setLoading(false));
    }
    if (activeTab === 'audit' && currentWorkspaceId) {
      setLoading(true);
      call<{ items: AuditLog[] }>(`/workspaces/${currentWorkspaceId}/audit-logs`)
        .then((res) => setAuditLogs(res.items))
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [activeTab, currentWorkspaceId, call]);

  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)} className="w-full">
      <TabsList>
        <TabsTrigger value="general" className="gap-1.5">
          <User className="h-3.5 w-3.5" />
          General
        </TabsTrigger>
        <TabsTrigger value="team" className="gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Team
        </TabsTrigger>
        <TabsTrigger value="audit" className="gap-1.5">
          <ClipboardList className="h-3.5 w-3.5" />
          Audit
        </TabsTrigger>
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
              <span className="text-sm font-medium text-foreground">{me?.workspaces.length ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="team" className="mt-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : members.length === 0 ? (
          <Card className="py-12 text-center">
            <CardDescription className="text-muted-foreground">No team members found.</CardDescription>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {members.map((member) => (
              <Card key={member.id}>
                <CardContent className="py-4 flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">{member.name ?? member.email}</span>
                    <span className="text-xs text-muted-foreground">{member.email}</span>
                  </div>
                  <Badge variant="secondary">{member.role}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
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
                      {log.user?.name ?? log.user?.email ?? 'System'} &middot;{' '}
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
