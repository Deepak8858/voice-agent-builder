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
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { useApi } from '@/lib/use-api';
import { ArrowLeft, Play, Power, Trash2, Plug } from 'lucide-react';

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
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-muted-foreground">Loading tool…</p>
      </div>
    );
  }
  if (toolQuery.isError || !toolQuery.data) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-destructive">{(toolQuery.error as Error)?.message}</p>
      </div>
    );
  }
  const tool = toolQuery.data;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            href="/dashboard/integrations"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to integrations
          </Link>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">
            {tool.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="capitalize">{tool.tool_type}</Badge>
            <Badge variant={tool.enabled ? 'default' : 'secondary'}>
              {tool.enabled ? 'enabled' : 'disabled'}
            </Badge>
            {tool.config.hmac_secret_set ? <Badge variant="outline">HMAC signed</Badge> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => toggleEnabled.mutate()} className="gap-2">
            <Power className="h-3.5 w-3.5" />
            {tool.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-destructive hover:bg-destructive/10"
            onClick={() => {
              if (confirm('Delete this tool?')) remove.mutate();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Play className="h-4 w-4 text-primary" />
              Test invocation
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">
              Send arguments as JSON. The server validates against the tool&apos;s input
              schema before firing the webhook.
            </p>
            <Textarea
              rows={10}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              className="font-mono text-xs"
            />
            <Button
              onClick={() => invokeMutation.mutate()}
              disabled={invokeMutation.isPending || !tool.enabled}
              className="gap-2 w-fit"
            >
              <Play className="h-4 w-4" />
              {invokeMutation.isPending ? 'Invoking…' : 'Invoke tool'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Plug className="h-4 w-4 text-primary" />
              Configuration
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <Row label="URL" value={tool.config.url} />
              <Row label="Method" value={tool.config.method ?? 'POST'} />
              <Row label="Timeout" value={`${tool.config.timeout_ms ?? 10_000} ms`} />
              <Row label="HMAC" value={tool.config.hmac_secret_set ? 'set' : 'not set'} />
              <Row label="Agent" value={tool.agent_id ?? 'workspace-wide'} />
            </dl>
            <Separator className="my-4" />
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Input schema</p>
            <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted p-4 font-mono text-xs">
              {JSON.stringify(tool.input_schema, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent invocations ({invocationsQuery.data?.items.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {invocationsQuery.data && invocationsQuery.data.items.length > 0 ? (
            <ul className="divide-y divide-border">
              {invocationsQuery.data.items.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {new Date(inv.started_at).toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {inv.duration_ms != null ? `${inv.duration_ms}ms · ` : ''}
                      {inv.error_message ?? '—'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {inv.response_status != null ? (
                      <span className="text-xs text-muted-foreground font-mono">HTTP {inv.response_status}</span>
                    ) : null}
                    <Badge variant="secondary">{inv.status}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No invocations yet. Use the test panel above to fire one.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value ?? '—'}</dd>
    </div>
  );
}
