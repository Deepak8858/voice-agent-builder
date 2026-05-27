'use client';

import { useMemo, useState } from 'react';
import type { AgentSummary } from '@voiceforge/shared';
import { Bot } from 'lucide-react';
import { AgentCard } from '@/components/dashboard/agent-card';
import { EmptyState } from '@/components/dashboard/empty-state';
import { SearchInput } from '@/components/dashboard/search-input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

interface AgentsListClientProps {
  agents: AgentSummary[];
}

const filters = [
  { id: 'all', label: 'All' },
  { id: 'published', label: 'Active' },
  { id: 'draft', label: 'Draft' },
  { id: 'paused', label: 'Paused' },
] as const;

export function AgentsListClient({ agents }: AgentsListClientProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<(typeof filters)[number]['id']>('all');

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return agents.filter((agent) => {
      const matchesStatus = status === 'all' || agent.status === status;
      const searchable = [
        agent.name,
        agent.description ?? '',
        agent.industry,
        agent.agent_type.replace(/_/g, ' '),
        agent.status,
      ]
        .join(' ')
        .toLowerCase();
      return matchesStatus && (!normalized || searchable.includes(normalized));
    });
  }, [agents, query, status]);

  if (agents.length === 0) {
    return (
      <EmptyState
        icon={<Bot className="h-7 w-7" />}
        title="No voice agents yet"
        description="Create your first agent and test it in minutes. VoiceForge will generate a provider-neutral Agent Spec JSON you can edit."
        actionHref="/dashboard/agents/new"
        actionLabel="Create Voice Agent"
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/90 p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search agents by name, use case, industry, or status…"
          className="w-full lg:max-w-xl"
        />
        <div className="flex flex-wrap gap-2">
          {filters.map((filter) => (
            <Button
              key={filter.id}
              type="button"
              variant={status === filter.id ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatus(filter.id)}
              className={cn('rounded-full', status === filter.id ? '' : 'bg-background/80')}
            >
              {filter.label}
            </Button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Bot className="h-7 w-7" />}
          title="No agents match your filters"
          description="Try a different search term or status filter."
          className="bg-card/75"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
