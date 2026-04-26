import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, Badge } from '@/components/ui/primitives';
import type { AgentSummary, SessionUser } from '@voiceforge/shared';

export default async function AgentsPage() {
  const me = await apiFetch<SessionUser>('/auth/me');
  const res = await apiFetch<{ items: AgentSummary[] }>(
    `/workspaces/${me.active_workspace_id}/agents`,
  );
  const agents = res.items;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Agents
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Build, test, and publish AI voice agents for your workspace.
          </p>
        </div>
        <Link href="/dashboard/agents/new">
          <Button>+ New agent</Button>
        </Link>
      </header>

      {agents.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <CardTitle>No agents yet</CardTitle>
          <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            Describe your agent in natural language and VoiceForge will generate a full
            Agent Spec JSON you can edit.
          </p>
          <Link href="/dashboard/agents/new">
            <Button size="lg">Create your first agent</Button>
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <Link
              key={a.id}
              href={`/dashboard/agents/${a.id}/builder`}
              className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">
                    {a.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {a.industry} \u00b7 {a.agent_type.replace('_', ' ')}
                  </p>
                </div>
                <Badge>{a.status}</Badge>
              </div>
              {a.description ? (
                <p className="mt-3 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
                  {a.description}
                </p>
              ) : null}
              <p className="mt-4 text-xs text-zinc-500">
                Updated {new Date(a.updated_at).toLocaleDateString()}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
