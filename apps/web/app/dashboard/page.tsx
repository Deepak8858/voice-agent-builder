import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import type { AgentSummary, SessionUser } from '@voiceforge/shared';
import {
  Bot,
  Phone,
  FileEdit,
  ArrowRight,
  CheckCircle2,
  Circle,
  Radio,
} from 'lucide-react';

export default async function DashboardHome() {
  let me: SessionUser | null = null;
  let agents: AgentSummary[] = [];
  let apiError: string | null = null;

  try {
    me = await apiFetch<SessionUser>('/auth/me');
    const res = await apiFetch<{ items: AgentSummary[] }>(
      `/workspaces/${me.active_workspace_id}/agents`,
    );
    agents = res.items;
  } catch (err) {
    apiError = (err as Error).message;
  }

  const publishedCount = agents.filter((a) => a.status === 'published').length;
  const draftCount = agents.filter((a) => a.status === 'draft').length;

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">
            {me ? `Welcome back${me.name ? `, ${me.name}` : ''}` : 'Welcome to VoiceForge'}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {me ? (
              <span className="inline-flex items-center gap-2">
                Workspace:
                <Badge variant="secondary">{me.active_workspace_name}</Badge>
              </span>
            ) : (
              'Set up your first agent to start answering calls.'
            )}
          </p>
        </div>
        <Link href="/dashboard/agents/new">
          <Button className="gap-2">
            <Bot className="h-4 w-4" />
            New agent
          </Button>
        </Link>
      </div>

      {apiError ? (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">API not reachable</CardTitle>
            <CardDescription>
              The backend returned: <code className="text-xs bg-muted px-1 py-0.5 rounded">{apiError}</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Start the API with <code className="text-xs bg-muted px-1 py-0.5 rounded">npm run dev</code>{' '}
              after setting DATABASE_URL in <code className="text-xs bg-muted px-1 py-0.5 rounded">.env</code>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="relative overflow-hidden">
              <div className="absolute right-4 top-4 h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Bot className="h-4 w-4 text-primary" />
              </div>
              <CardHeader className="pb-2">
                <CardDescription>Total agents</CardDescription>
                <CardTitle className="text-3xl font-semibold">{agents.length}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">In this workspace</p>
              </CardContent>
            </Card>
            <Card className="relative overflow-hidden">
              <div className="absolute right-4 top-4 h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Radio className="h-4 w-4 text-emerald-600" />
              </div>
              <CardHeader className="pb-2">
                <CardDescription>Published</CardDescription>
                <CardTitle className="text-3xl font-semibold">{publishedCount}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Currently accepting calls</p>
              </CardContent>
            </Card>
            <Card className="relative overflow-hidden">
              <div className="absolute right-4 top-4 h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <FileEdit className="h-4 w-4 text-amber-600" />
              </div>
              <CardHeader className="pb-2">
                <CardDescription>Drafts</CardDescription>
                <CardTitle className="text-3xl font-semibold">{draftCount}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Work in progress</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
            {/* Quick links */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Quick actions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    { href: '/dashboard/agents/new', label: 'Create new agent', desc: 'Start from a prompt or template', icon: Bot },
                    { href: '/dashboard/calls', label: 'Review calls', desc: 'Listen to transcripts and outcomes', icon: Phone },
                    { href: '/dashboard/templates', label: 'Browse templates', desc: 'Use pre-built agent configurations', icon: FileEdit },
                    { href: '/dashboard/analytics', label: 'View analytics', desc: 'Performance and compliance metrics', icon: Radio },
                  ].map((action) => (
                    <Link
                      key={action.href}
                      href={action.href}
                      className="group flex items-center gap-4 rounded-lg border border-border bg-background p-4 transition-all hover:border-primary/30 hover:bg-accent hover:shadow-sm"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                        <action.icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{action.label}</p>
                        <p className="text-xs text-muted-foreground">{action.desc}</p>
                      </div>
                      <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Checklist */}
            <Card>
              <CardHeader>
                <CardTitle>Setup checklist</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {[
                    { text: 'Create your first agent from a template or prompt', done: agents.length > 0 },
                    { text: 'Upload FAQs or a PDF knowledge base', done: false },
                    { text: 'Connect Google Calendar for booking tools', done: false },
                    { text: 'Test a call and review the transcript', done: false },
                    { text: 'Configure compliance: consent, DNC, opt-out', done: false },
                    { text: 'Brand your client dashboard', done: false },
                  ].map((item) => (
                    <li key={item.text} className="flex items-start gap-3">
                      {item.done ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      ) : (
                        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" />
                      )}
                      <span className={cn('text-sm', item.done ? 'text-muted-foreground line-through' : 'text-foreground')}>
                        {item.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
