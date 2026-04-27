import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiCallError } from '@/lib/api';
import { Card, CardTitle, Badge } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { KnowledgePanel } from '@/components/knowledge-panel';
import { SuggestionsPanel } from '@/components/suggestions-panel';
import { TestCallDrawer } from '@/components/test-call-drawer';
import type { AgentDetail, SessionUser } from '@voiceforge/shared';

interface PageProps {
  params: Promise<{ agentId: string }>;
}

export default async function AgentBuilderPage({ params }: PageProps) {
  const { agentId } = await params;
  const me = await apiFetch<SessionUser>('/auth/me');
  let agent: AgentDetail;
  try {
    agent = await apiFetch<AgentDetail>(
      `/workspaces/${me.active_workspace_id}/agents/${agentId}`,
    );
  } catch (err) {
    if (err instanceof ApiCallError && err.status === 404) return notFound();
    throw err;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/dashboard/agents"
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            \u2190 Back to agents
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {agent.name}
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Badge>{agent.status}</Badge>
            <span>
              {agent.industry} \u00b7 {agent.agent_type.replace('_', ' ')}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TestCallDrawer workspaceId={me.active_workspace_id} agentId={agent.id} />
          <Button>Publish</Button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardTitle>Agent Spec JSON</CardTitle>
          {agent.active_spec ? (
            <pre className="mt-3 max-h-[32rem] overflow-auto rounded-md bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-100">
              {JSON.stringify(agent.active_spec, null, 2)}
            </pre>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">No active version. Save a draft spec first.</p>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>Versions ({agent.versions.length})</CardTitle>
            <ul className="mt-3 space-y-2 text-sm">
              {agent.versions.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                >
                  <div>
                    <p className="font-medium text-zinc-900 dark:text-zinc-50">
                      v{v.version_number}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {new Date(v.created_at).toLocaleString()}
                    </p>
                  </div>
                  <Badge>{v.deployment_status.replace('_', ' ')}</Badge>
                </li>
              ))}
              {agent.versions.length === 0 ? (
                <li className="text-xs text-zinc-500">No versions yet.</li>
              ) : null}
            </ul>
          </Card>

          <KnowledgePanel workspaceId={me.active_workspace_id} agentId={agent.id} />

          <SuggestionsPanel workspaceId={me.active_workspace_id} agentId={agent.id} />

          <Card>
            <CardTitle>Coming soon</CardTitle>
            <ul className="mt-3 space-y-1 text-xs text-zinc-500">
              <li>Visual flow builder (Phase 2)</li>
              <li>Embeddings + retrieval (Phase 2)</li>
              <li>Real Vapi/Retell deploy (Phase 3+)</li>
              <li>Compliance editor (Phase 6)</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
