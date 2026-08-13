import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { EmptyState, PageHeader, StatCard, StatusBadge } from '@/components/dashboard';
import type { CallSummary, SessionUser } from '@voiceforge/shared';
import { ArrowRight, CheckCircle2, Clock3, FlaskConical, Phone } from 'lucide-react';

export default async function CallsPage() {
  let items: CallSummary[] = [];
  let apiError: string | null = null;

  try {
    const me = await apiFetch<SessionUser>('/auth/me');
    const res = await apiFetch<{ items: CallSummary[] }>(
      `/workspaces/${me.active_workspace_id}/calls`,
    );
    items = res.items;
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (apiError) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          eyebrow="Voice operations"
          title="Calls"
          description={
            <>
              Could not load calls:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{apiError}</code>
            </>
          }
        />
      </div>
    );
  }
  const completedCalls = items.filter((call) => call.status === 'completed').length;
  const liveCalls = items.filter((call) => ['queued', 'ringing', 'in_progress'].includes(call.status)).length;
  const browserTests = items.filter((call) => call.direction === 'browser_test').length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Voice operations"
        title="Calls"
        description="Review browser tests, inbound calls, outbound calls, transcripts, and post-call outcomes across this workspace."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total calls"
          value={items.length}
          description="All call records in this workspace."
          icon={<Phone className="h-5 w-5" />}
        />
        <StatCard
          label="Completed"
          value={completedCalls}
          description="Calls with finished transcripts and metadata."
          icon={<CheckCircle2 className="h-5 w-5" />}
          tone="success"
        />
        <StatCard
          label="Live / queued"
          value={liveCalls}
          description="Calls still in progress or waiting to start."
          icon={<Clock3 className="h-5 w-5" />}
          tone="info"
        />
        <StatCard
          label="Browser tests"
          value={browserTests}
          description="Test calls started from the builder."
          icon={<FlaskConical className="h-5 w-5" />}
          tone="warning"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent calls ({items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              icon={<Phone className="h-7 w-7" />}
              title="No calls yet"
              description="Open an agent and start a browser test call to generate a transcript and call record."
              actionLabel="Open agents"
              actionHref="/dashboard/agents"
            />
          ) : (
            /* ph-no-capture: rows render contact names and dialled numbers. */
            <ul className="ph-no-capture divide-y divide-border">
              {items.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/dashboard/calls/${c.id}`}
                    className="group flex items-center justify-between gap-4 py-4 text-sm transition-colors hover:bg-accent/30 px-2 -mx-2 rounded-lg"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">
                        {c.contact_name ?? c.to_number ?? c.from_number ?? 'Unknown contact'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <span className="capitalize">{c.direction.replace('_', ' ')}</span>
                        {' · '}
                        {c.provider}
                        {' · '}
                        {new Date(c.created_at).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {c.duration_seconds != null ? (
                        <span className="text-xs text-muted-foreground font-mono">
                          {c.duration_seconds}s
                        </span>
                      ) : null}
                      <StatusBadge status={c.status} />
                      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
