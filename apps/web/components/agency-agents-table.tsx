'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, CardTitle } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

interface AgencyAgent {
  agent_id: string;
  agent_name: string;
  agent_status: string;
  agent_type: string;
  industry: string;
  client_workspace_id: string;
  client_workspace_name: string;
  created_at: string;
  updated_at: string;
}

export function AgencyAgentsTable({ workspaceId }: { workspaceId: string }) {
  const { call } = useApi();
  const list = useQuery({
    queryKey: ['agency', 'agents', workspaceId],
    queryFn: () =>
      call<{ items: AgencyAgent[] }>(`/workspaces/${workspaceId}/clients/agents`),
  });

  if (list.isLoading) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }
  if (list.error) {
    return <p className="text-sm text-red-600">{(list.error as Error).message}</p>;
  }
  if (!list.data?.items.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No client agents yet</CardTitle>
        </CardHeader>
        <p className="px-6 pb-6 text-sm text-zinc-500">
          Create a client workspace first, then their agents will appear here.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <table className="w-full text-sm">
        <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="px-6 py-3 text-left">Agent</th>
            <th className="px-6 py-3 text-left">Client</th>
            <th className="px-6 py-3 text-left">Type</th>
            <th className="px-6 py-3 text-left">Status</th>
            <th className="px-6 py-3 text-left">Updated</th>
          </tr>
        </thead>
        <tbody>
          {list.data.items.map((row) => (
            <tr key={row.agent_id} className="border-b border-zinc-100 dark:border-zinc-900">
              <td className="px-6 py-3">
                <div className="font-medium text-zinc-900 dark:text-zinc-50">{row.agent_name}</div>
                <div className="text-xs text-zinc-500">{row.industry}</div>
              </td>
              <td className="px-6 py-3 text-zinc-600 dark:text-zinc-400">
                {row.client_workspace_name}
              </td>
              <td className="px-6 py-3 text-xs text-zinc-500">
                {row.agent_type.replace(/_/g, ' ')}
              </td>
              <td className="px-6 py-3">
                <Badge>{row.agent_status}</Badge>
              </td>
              <td className="px-6 py-3 text-xs text-zinc-500">
                {new Date(row.updated_at).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
