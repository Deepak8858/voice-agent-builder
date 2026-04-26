'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  SessionUser,
  ToolDetail,
  ToolInvocationDetail,
  ToolInvocationSummary,
} from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle, Textarea } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

interface PageProps {
  params: Promise<{ toolId: string }>;
}

export default function ToolDetailPage({ params }: PageProps) {
  const { toolId } = use(params);
  const router = useRouter();
  const { call } = useApi();
  const qc = useQueryClient();

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [argsText, setArgsText] = useState('{\n  "name": "Ada",\n  "phone": "5551234567"\n}');

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch((err) => toast.error(`Session: ${err.message}`));
  }, [call]);

  const toolQuery = useQuery({
    queryKey: ['tool', workspaceId, toolId],
    enabled: Boolean(workspaceId),
    queryFn: () => call<ToolDetail>(`/workspaces/${workspaceId}/tools/${toolId}`),
  });

  const invocationsQuery = useQuery({
    queryKey: ['tool-invocations', workspaceId, toolId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      call<{ items: ToolInvocationSummary[] }>(
        `/workspaces/${workspaceId}/tool-invocations?tool_id=${toolId}`,
      ),
  });

  const invokeMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace');
      let args: unknown = {};
      try {
        args = JSON.parse(argsText);
      } catch (err) {
        throw new Error(`Arguments must be valid JSON: ${(err as Error).message}`);
      }
      return call<ToolInvocationDetail>(
        `/workspaces/${workspaceId}/tools/${toolId}/invoke`,
        { method: 'POST', body: JSON.stringify({ arguments: args }) },
      );
    },
    onSuccess: (inv) => {
      toast.success(`Invocation ${inv.status} (${inv.response_status ?? '—'})`);
      qc.invalidateQueries({ queryKey: ['tool-invocations', workspaceId, toolId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleEnabled = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !toolQuery.data) throw new Error('No tool loaded');
      return call<ToolDetail>(`/workspaces/${workspaceId}/tools/${toolId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !toolQuery.data.enabled }),
      });
    },
    onSuccess: () => {
      toast.success('Toggled.');
      qc.invalidateQueries({ queryKey: ['tool', workspaceId, toolId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace');
      await call<void>(`/workspaces/${workspaceId}/tools/${toolId}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      toast.success('Tool deleted.');
      router.push('/dashboard/integrations');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (toolQuery.isPending) {
    return <p className="text-sm text-zinc-500">Loading tool…</p>;
  }
  if (toolQuery.isError || !toolQuery.data) {
    return <p className="text-sm text-red-600">{(toolQuery.error as Error)?.message}</p>;
  }
  const tool = toolQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/dashboard/integrations"
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            ← Back to integrations
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {tool.name}
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Badge>{tool.tool_type}</Badge>
            <Badge>{tool.enabled ? 'enabled' : 'disabled'}</Badge>
            {tool.config.hmac_secret_set ? <Badge>HMAC signed</Badge> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => toggleEnabled.mutate()}>
            {tool.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (confirm('Delete this tool?')) remove.mutate();
            }}
          >
            Delete
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardTitle>Test invocation</CardTitle>
          <p className="mt-2 text-xs text-zinc-500">
            Send arguments as JSON. The server validates against the tool&apos;s input
            schema before firing the webhook.
          </p>
          <Textarea
            rows={10}
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            className="mt-3 font-mono text-xs"
          />
          <div className="mt-3">
            <Button
              onClick={() => invokeMutation.mutate()}
              disabled={invokeMutation.isPending || !tool.enabled}
            >
              {invokeMutation.isPending ? 'Invoking…' : 'Invoke tool'}
            </Button>
          </div>
        </Card>

        <Card>
          <CardTitle>Configuration</CardTitle>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="URL" value={tool.config.url} />
            <Row label="Method" value={tool.config.method ?? 'POST'} />
            <Row label="Timeout" value={`${tool.config.timeout_ms ?? 10_000} ms`} />
            <Row label="HMAC" value={tool.config.hmac_secret_set ? 'set' : 'not set'} />
            <Row label="Agent" value={tool.agent_id ?? 'workspace-wide'} />
          </dl>
          <p className="mt-4 text-xs uppercase tracking-wide text-zinc-500">Input schema</p>
          <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900">
            {JSON.stringify(tool.input_schema, null, 2)}
          </pre>
        </Card>
      </div>

      <Card>
        <CardTitle>Recent invocations ({invocationsQuery.data?.items.length ?? 0})</CardTitle>
        {invocationsQuery.data && invocationsQuery.data.items.length > 0 ? (
          <ul className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800">
            {invocationsQuery.data.items.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900 dark:text-zinc-50">
                    {new Date(inv.started_at).toLocaleString()}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {inv.duration_ms != null ? `${inv.duration_ms}ms · ` : ''}
                    {inv.error_message ?? '—'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {inv.response_status != null ? (
                    <span className="text-xs text-zinc-500">HTTP {inv.response_status}</span>
                  ) : null}
                  <Badge>{inv.status}</Badge>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">
            No invocations yet. Use the test panel above to fire one.
          </p>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="text-right font-medium text-zinc-900 dark:text-zinc-50">
        {value ?? '—'}
      </dd>
    </div>
  );
}
