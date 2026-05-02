'use client';
import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/use-api';

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
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(['general', 'team', 'audit'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'general' && (
        <Card>
          <CardHeader>
            <CardTitle>Account Information</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500 dark:text-zinc-400">User ID</span>
              <span className="text-sm font-mono">{me?.id ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500 dark:text-zinc-400">Workspaces</span>
              <span className="text-sm">{me?.workspaces.length ?? 0}</span>
            </div>
          </div>
        </Card>
      )}

      {activeTab === 'team' && (
        <div className="flex flex-col gap-3">
          {loading ? (
            <p className="text-sm text-zinc-500">Loading members...</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-zinc-500">No team members found.</p>
          ) : (
            members.map((member) => (
              <Card key={member.id}>
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{member.name ?? member.email}</span>
                    <span className="text-xs text-zinc-500">{member.email}</span>
                  </div>
                  <Badge>{member.role}</Badge>
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="flex flex-col gap-2">
          {loading ? (
            <p className="text-sm text-zinc-500">Loading audit logs...</p>
          ) : auditLogs.length === 0 ? (
            <p className="text-sm text-zinc-500">No audit logs found.</p>
          ) : (
            auditLogs.map((log) => (
              <Card key={log.id}>
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{log.action}</span>
                    <span className="text-xs text-zinc-500">
                      {log.user?.name ?? log.user?.email ?? 'System'} &middot;{' '}
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}