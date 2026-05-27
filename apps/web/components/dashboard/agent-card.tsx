import Link from 'next/link';
import type { AgentSummary } from '@voiceforge/shared';
import { ArrowRight, Bot, Clock3, PhoneCall } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from './status-badge';

interface AgentCardProps {
  agent: AgentSummary;
}

export function AgentCard({ agent }: AgentCardProps) {
  const builderHref = `/dashboard/agents/${agent.id}/builder`;

  return (
    <Card className="group overflow-hidden bg-card/90 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <CardContent className="p-0">
        <div className="border-b border-border/70 bg-gradient-to-br from-primary/10 via-card to-sky-500/10 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-background/80 text-primary shadow-sm">
                <Bot className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <Link href={builderHref} className="block focus:outline-none">
                  <h2 className="truncate text-base font-semibold tracking-tight text-foreground group-hover:text-primary">
                    {agent.name}
                  </h2>
                </Link>
                <p className="mt-1 text-xs capitalize text-muted-foreground">
                  {agent.industry} · {agent.agent_type.replace(/_/g, ' ')}
                </p>
              </div>
            </div>
            <StatusBadge status={agent.status} className="shrink-0" />
          </div>
          {agent.description ? (
            <p className="mt-4 line-clamp-2 text-sm leading-6 text-muted-foreground">{agent.description}</p>
          ) : (
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Define how this agent should speak, behave, and handle calls.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" />
            Updated {new Date(agent.updated_at).toLocaleDateString()}
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href={`${builderHref}#testing`}>
                <PhoneCall className="h-3.5 w-3.5" />
                Test
              </Link>
            </Button>
            <Button asChild size="sm" className="gap-1.5">
              <Link href={builderHref}>
                Configure
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
