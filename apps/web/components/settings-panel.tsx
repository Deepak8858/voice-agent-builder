'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, CardHeader, CardTitle } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

interface AuditLogItem {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_email: string | null;
  metadata: unknown;
  created_at: string;
}

interface MembershipItem {
  id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  created_at: string;
}

interface SettingsPanelProps {
  workspaceId: string;
  workspaceName: string;
  workspaceRole: string;
}

type Tab = 'general' | 'team' | 'audit';

export function SettingsPanel({
  workspaceId,
  workspaceName,
  workspaceRole,
}: SettingsPanelProps) {
  const { call } = useApi();
  const [tab, setTab] = useState<Tab>('general');

  const team = useQuery({
    queryKey: ['settings', 'team', workspaceId],
    queryFn: () => call<{ items: MembershipItem[] }>(`/workspaces/${workspaceId}/members`),
    enabled: tab === 'team',
  });

  const audit = useQuery({
    queryKey: ['settings', 'audit', workspaceId],
    queryFn: () =>
      call<{ items: AuditLogItem[]; next_cursor: string | null }>(
        `/workspaces/${workspaceId}/audit-logs?limit=100`,
      ),
    enabled: tab === 'audit',
  });

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {(['general', 'team', 'audit'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm capitalize transition-colors ${
              tab === t
                ? 'border-emerald-500 font-medium text-zinc-900 dark:text-zinc-50'
                : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50'
            }`}
          >
            {t === 'audit' ? 'Audit log' : t}
          </button>
        ))}
      </nav>

      {tab === 'general' ? (
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 gap-4 px-6 pb-6 text-sm sm:grid-cols-2">
            <Field label="Workspace name" value={workspaceName} />
            <Field label="Workspace ID" value={workspaceId} mono />
            <Field label="Your role" value={workspaceRole} />
          </div>
        </Card>
      ) : null}

      {tab === 'team' ? (
        <Card>
          <CardHeader>
            <CardTitle>Team members</CardTitle>
          </CardHeader>
          <div className="px-6 pb-6">
            {team.isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : team.data?.items.length ? (
              <table className="w-full text-sm">
                <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
                  <tr>
                    <th className="py-2 text-left">Member</th>
                    <th className="py-2 text-left">Role</th>
                    <th className="py-2 text-left">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {team.data.items.map((m) => (
                    <tr key={m.id} className="border-b border-zinc-100 dark:border-zinc-900">
                      <td className="py-2">
                        <div className="font-medium">{m.name ?? m.email ?? m.user_id}</div>
                        {m.email ? <div className="text-xs text-zinc-500">{m.email}</div> : null}
                      </td>
                      <td className="py-2">
                        <Badge>{m.role}</Badge>
                      </td>
                      <td className="py-2 text-zinc-500">
                        {new Date(m.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-zinc-500">No team members yet.</p>
            )}
          </div>
        </Card>
      ) : null}

      {tab === 'audit' ? (
        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
          </CardHeader>
          <div className="px-6 pb-6">
            {audit.isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : audit.data?.items.length ? (
              <table className="w-full text-sm">
                <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
                  <tr>
                    <th className="py-2 text-left">When</th>
                    <th className="py-2 text-left">Actor</th>
                    <th className="py-2 text-left">Action</th>
                    <th className="py-2 text-left">Resource</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.items.map((row) => (
                    <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-900">
                      <td className="py-2 text-zinc-500">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td className="py-2">{row.actor_email ?? 'system'}</td>
                      <td className="py-2 font-mono text-xs">{row.action}</td>
                      <td className="py-2 text-xs text-zinc-500">
                        {row.resource_type}
                        {row.resource_id ? `:${row.resource_id.slice(0, 8)}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-zinc-500">No audit events yet.</p>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase text-zinc-500">{label}</span>
      <span className={`text-sm text-zinc-900 dark:text-zinc-50 ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}
