import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AgentCard } from '@/components/dashboard/agent-card';
import { EmptyState } from '@/components/dashboard/empty-state';
import { PageHeader } from '@/components/dashboard/page-header';
import { StatCard } from '@/components/dashboard/stat-card';
import { StatusBadge } from '@/components/dashboard/status-badge';
import type { AgentSummary, CallSummary, SessionUser } from '@voiceforge/shared';
import {
  Bot,
  Phone,
  FileEdit,
  ArrowRight,
  CheckCircle2,
  Circle,
  Radio,
  Sparkles,
  ShieldCheck,
  BookOpen,
} from 'lucide-react';

export default async function DashboardHome() {
  let me: SessionUser | null = null;
  let agents: AgentSummary[] = [];
  let calls: CallSummary[] = [];
  let apiError: string | null = null;

  try {
    me = await apiFetch<SessionUser>('/auth/me');
    const [agentsRes, callsRes] = await Promise.all([
      apiFetch<{ items: AgentSummary[] }>(`/workspaces/${me.active_workspace_id}/agents`),
      apiFetch<{ items: CallSummary[] }>(`/workspaces/${me.active_workspace_id}/calls`),
    ]);
    agents = agentsRes.items;
    calls = callsRes.items;
  } catch (err) {
    apiError = (err as Error).message;
  }

  const activeCount = agents.filter((agent) => agent.status === 'published').length;
  const draftCount = agents.filter((agent) => agent.status === 'draft').length;
  const testCallCount = calls.filter((call) => call.direction === 'browser_test').length;
  const recentAgents = agents.slice(0, 3);
  const recentCalls = calls.slice(0, 5);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={me ? me.active_workspace_name : 'VoiceForge'}
        title="Build and test AI voice agents for real customer conversations."
        description="Create agents that can qualify leads, answer questions, book appointments, and handle phone calls with natural conversation."
        actions={
          <>
            <Button asChild variant="outline" className="gap-2">
              <Link href="/dashboard/templates">
                <FileEdit className="h-4 w-4" />
                Browse templates
              </Link>
            </Button>
            <Button asChild className="gap-2">
              <Link href="/dashboard/agents/new">
                <Bot className="h-4 w-4" />
                Create Voice Agent
              </Link>
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
            <ShieldCheck className="h-3.5 w-3.5" />
            Workspace scoped
          </Badge>
          <Badge variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
            <Radio className="h-3.5 w-3.5" />
            Test before publish
          </Badge>
          <Badge variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
            <BookOpen className="h-3.5 w-3.5" />
            Knowledge-ready
          </Badge>
        </div>
      </PageHeader>

      {apiError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">API not reachable</CardTitle>
            <CardDescription>
              The backend returned:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{apiError}</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-6 text-muted-foreground">
              Start the API with <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run dev</code>{' '}
              after configuring the required environment variables.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total agents"
              value={agents.length}
              description="Voice agents in this workspace"
              icon={<Bot className="h-5 w-5" />}
            />
            <StatCard
              label="Active agents"
              value={activeCount}
              description="Published and ready to receive calls"
              icon={<Radio className="h-5 w-5" />}
              tone="success"
            />
            <StatCard
              label="Draft agents"
              value={draftCount}
              description="Configuration work in progress"
              icon={<FileEdit className="h-5 w-5" />}
              tone="warning"
            />
            <StatCard
              label="Test calls"
              value={testCallCount}
              description="Browser test sessions captured"
              icon={<Phone className="h-5 w-5" />}
              tone="info"
            />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.8fr)]">
            <section className="flex flex-col gap-6">
              <Card className="overflow-hidden bg-card/90">
                <CardHeader className="flex flex-col gap-3 border-b border-border/70 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle>Recent voice agents</CardTitle>
                    <CardDescription>Open an agent to adjust instructions, add knowledge, or run a test call.</CardDescription>
                  </div>
                  <Button asChild variant="outline" size="sm" className="gap-2">
                    <Link href="/dashboard/agents">
                      View all
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent className="p-5">
                  {recentAgents.length === 0 ? (
                    <EmptyState
                      icon={<Bot className="h-7 w-7" />}
                      title="No voice agents yet"
                      description="Create your first agent and test it in minutes. Start with a template or describe the phone workflow you want automated."
                      actionHref="/dashboard/agents/new"
                      actionLabel="Create Voice Agent"
                      className="border-0 bg-muted/40 shadow-none"
                    />
                  ) : (
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                      {recentAgents.map((agent) => (
                        <AgentCard key={agent.id} agent={agent} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card/90">
                <CardHeader>
                  <CardTitle>Recent activity</CardTitle>
                  <CardDescription>Latest test, inbound, and outbound call records.</CardDescription>
                </CardHeader>
                <CardContent>
                  {recentCalls.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
                      No calls yet. Open an agent and choose “Test Agent” to generate a browser test session.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border/70">
                      {recentCalls.map((call) => (
                        <li key={call.id} className="py-3">
                          <Link
                            href={`/dashboard/calls/${call.id}`}
                            className="group flex items-center justify-between gap-3 rounded-xl px-2 py-2 transition hover:bg-accent/45"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">
                                {call.contact_name ?? call.to_number ?? call.from_number ?? 'Unknown caller'}
                              </p>
                              <p className="mt-0.5 text-xs capitalize text-muted-foreground">
                                {call.direction.replace(/_/g, ' ')} · {call.provider} ·{' '}
                                {new Date(call.created_at).toLocaleString()}
                              </p>
                            </div>
                            <StatusBadge status={call.status} className="shrink-0" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </section>

            <aside className="flex flex-col gap-6">
              <Card className="overflow-hidden bg-card/90">
                <CardHeader>
                  <CardTitle>Getting started</CardTitle>
                  <CardDescription>Follow the shortest path to a production-ready voice agent.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-4">
                    {[
                      { text: 'Create your first voice agent', done: agents.length > 0, href: '/dashboard/agents/new' },
                      { text: 'Add clear instructions and business context', done: agents.some((agent) => agent.description), href: '/dashboard/agents' },
                      { text: 'Run a browser test conversation', done: testCallCount > 0, href: '/dashboard/agents' },
                      { text: 'Add knowledge or FAQs', done: false, href: '/dashboard/knowledge' },
                      { text: 'Publish when ready for real calls', done: activeCount > 0, href: '/dashboard/agents' },
                    ].map((item) => (
                      <li key={item.text} className="flex items-start gap-3">
                        {item.done ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        ) : (
                          <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/45" />
                        )}
                        <Link
                          href={item.href}
                          className={item.done ? 'text-sm text-muted-foreground line-through' : 'text-sm text-foreground hover:text-primary'}
                        >
                          {item.text}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <Card className="border-primary/20 bg-gradient-to-br from-primary/10 via-card to-sky-500/10">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" />
                    Prompt tip
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Write instructions like you are training a human phone agent. Include goals, tone, rules,
                    and what to do when unsure.
                  </p>
                  <Button asChild className="mt-4 w-full gap-2">
                    <Link href="/dashboard/agents/new/ai-generate">
                      Try AI generator
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}