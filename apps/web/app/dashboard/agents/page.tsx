import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { AgentSummary, SessionUser } from '@voiceforge/shared';
import { Bot, Plus, ArrowRight } from 'lucide-react';

export default async function AgentsPage() {
  let agents: AgentSummary[] = [];
  let apiError: string | null = null;

  try {
    const me = await apiFetch<SessionUser>('/auth/me');
    const res = await apiFetch<{ items: AgentSummary[] }>(
      `/workspaces/${me.active_workspace_id}/agents`,
    );
    agents = res.items;
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (apiError) {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Agents</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Could not load agents: <code className="text-xs bg-muted px-1 py-0.5 rounded">{apiError}</code>
            </p>
          </div>
          <Link href="/dashboard/agents/new">
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              New agent
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build, test, and publish AI voice agents for your workspace.
          </p>
        </div>
        <Link href="/dashboard/agents/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" />
            New agent
          </Button>
        </Link>
      </div>

      {agents.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent">
            <Bot className="h-7 w-7 text-accent-foreground" />
          </div>
          <div>
            <CardTitle className="text-lg">No agents yet</CardTitle>
            <CardDescription className="max-w-sm mx-auto mt-1">
              Describe your agent in natural language and VoiceForge will generate a full
              Agent Spec JSON you can edit.
            </CardDescription>
          </div>
          <Link href="/dashboard/agents/new">
            <Button size="lg" className="gap-2 mt-2">
              Create your first agent
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <Link
              key={a.id}
              href={`/dashboard/agents/${a.id}/builder`}
              className="group relative rounded-xl border border-border bg-card p-5 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5 hover:border-primary/20"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-foreground">
                    {a.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground capitalize">
                    {a.industry} &middot; {a.agent_type.replace('_', ' ')}
                  </p>
                </div>
                <Badge
                  variant={a.status === 'published' ? 'default' : 'secondary'}
                  className="shrink-0 capitalize"
                >
                  {a.status}
                </Badge>
              </div>
              {a.description ? (
                <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                  {a.description}
                </p>
              ) : null}
              <div className="mt-4 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Updated {new Date(a.updated_at).toLocaleDateString()}
                </p>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-1" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
