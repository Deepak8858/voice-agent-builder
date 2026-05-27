import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AgentsListClient } from '@/components/agents/agents-list-client';
import { PageHeader } from '@/components/dashboard/page-header';
import { StatCard } from '@/components/dashboard/stat-card';
import type { AgentSummary, SessionUser } from '@voiceforge/shared';
import { Bot, Plus, Radio, FileEdit, PauseCircle } from 'lucide-react';

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

  const activeCount = agents.filter((agent) => agent.status === 'published').length;
  const draftCount = agents.filter((agent) => agent.status === 'draft').length;
  const pausedCount = agents.filter((agent) => agent.status === 'paused').length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Voice agents"
        title="Manage the agents that talk to your customers."
        description="Search, configure, test, and publish phone agents for lead qualification, support, bookings, sales follow-up, and business automation."
        actions={
          <Button asChild className="gap-2">
            <Link href="/dashboard/agents/new">
              <Plus className="h-4 w-4" />
              Create Voice Agent
            </Link>
          </Button>
        }
      />

      {apiError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">Could not load agents</CardTitle>
            <CardDescription>
              The backend returned:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{apiError}</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Check that the API is running and that the workspace session is valid.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total" value={agents.length} description="All workspace agents" icon={<Bot className="h-5 w-5" />} />
            <StatCard label="Active" value={activeCount} description="Published agents" icon={<Radio className="h-5 w-5" />} tone="success" />
            <StatCard label="Draft" value={draftCount} description="Still being configured" icon={<FileEdit className="h-5 w-5" />} tone="warning" />
            <StatCard label="Paused" value={pausedCount} description="Temporarily disabled" icon={<PauseCircle className="h-5 w-5" />} tone="info" />
          </div>
          <AgentsListClient agents={agents} />
        </>
      )}
    </div>
  );
}