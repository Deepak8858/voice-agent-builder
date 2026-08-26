import { cache, Suspense } from 'react';
import Link from 'next/link';
import { apiFetch, requireSessionUser } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { AgentsListClient } from '@/components/agents/agents-list-client';
import { PageHeader } from '@/components/dashboard/page-header';
import { StatCard } from '@/components/dashboard/stat-card';
import { CardGridSkeleton, StatGridSkeleton } from '@/components/dashboard/page-skeleton';
import { SessionErrorCard } from '@/components/dashboard/session-error-card';
import type { AgentSummary } from '@voiceforge/shared';
import { Bot, Plus, Radio, FileEdit, PauseCircle } from 'lucide-react';

interface AgentsData {
  agents: AgentSummary[];
  apiError: string | null;
}

/**
 * React `cache()` deduplicates this loader across both suspended sections in
 * one server render, including the request-scoped session lookup.
 */
const loadAgents = cache(async (): Promise<AgentsData> => {
  const me = await requireSessionUser('/dashboard/agents');
  if (!me.active_workspace_id) {
    return { agents: [], apiError: 'No active workspace selected.' };
  }
  try {
    const res = await apiFetch<{ items: AgentSummary[] }>(
      `/workspaces/${me.active_workspace_id}/agents`,
    );
    return { agents: res.items, apiError: null };
  } catch (err) {
    return { agents: [], apiError: (err as Error).message };
  }
});

export default function AgentsPage() {
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

      <Suspense fallback={<StatGridSkeleton />}>
        <AgentStats />
      </Suspense>

      <Suspense fallback={<CardGridSkeleton cards={6} />}>
        <AgentList />
      </Suspense>
    </div>
  );
}

async function AgentStats() {
  const { agents, apiError } = await loadAgents();
  if (apiError) return <SessionErrorCard title="Could not load agents" message={apiError} />;

  const activeCount = agents.filter((agent) => agent.status === 'published').length;
  const draftCount = agents.filter((agent) => agent.status === 'draft').length;
  const pausedCount = agents.filter((agent) => agent.status === 'paused').length;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Total" value={agents.length} description="All workspace agents" icon={<Bot className="h-5 w-5" />} />
      <StatCard label="Active" value={activeCount} description="Published agents" icon={<Radio className="h-5 w-5" />} tone="success" />
      <StatCard label="Draft" value={draftCount} description="Still being configured" icon={<FileEdit className="h-5 w-5" />} tone="warning" />
      <StatCard label="Paused" value={pausedCount} description="Temporarily disabled" icon={<PauseCircle className="h-5 w-5" />} tone="info" />
    </div>
  );
}

async function AgentList() {
  const { agents, apiError } = await loadAgents();
  if (apiError) return null;
  return <AgentsListClient agents={agents} />;
}
