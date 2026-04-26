import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, Badge } from '@/components/ui/primitives';
import type { AgentSummary, SessionUser } from '@voiceforge/shared';

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

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {me ? `Welcome back${me.name ? `, ${me.name}` : ''}.` : 'Welcome to VoiceForge.'}
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {me ? (
              <>
                Workspace: <Badge>{me.active_workspace_name}</Badge>
              </>
            ) : (
              <>Set up your first agent to start answering calls.</>
            )}
          </p>
        </div>
        <Link href="/dashboard/agents/new">
          <Button>+ New agent</Button>
        </Link>
      </header>

      {apiError ? (
        <Card>
          <CardTitle>API not reachable</CardTitle>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            The backend returned: <code className="text-xs">{apiError}</code>
          </p>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Start the API with <code className="text-xs">npm run dev</code> after setting
            DATABASE_URL in <code className="text-xs">.env</code>.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card>
            <CardTitle>Agents</CardTitle>
            <p className="mt-2 text-3xl font-semibold">{agents.length}</p>
            <p className="mt-1 text-xs text-zinc-500">Total agents in this workspace</p>
          </Card>
          <Card>
            <CardTitle>Published</CardTitle>
            <p className="mt-2 text-3xl font-semibold">
              {agents.filter((a) => a.status === 'published').length}
            </p>
            <p className="mt-1 text-xs text-zinc-500">Currently accepting calls</p>
          </Card>
          <Card>
            <CardTitle>Drafts</CardTitle>
            <p className="mt-2 text-3xl font-semibold">
              {agents.filter((a) => a.status === 'draft').length}
            </p>
            <p className="mt-1 text-xs text-zinc-500">Work in progress</p>
          </Card>
        </div>
      )}

      <Card>
        <CardTitle>Setup checklist</CardTitle>
        <ul className="mt-3 space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
          <li>\u2022 Create your first agent from a template or prompt</li>
          <li>\u2022 Upload FAQs or a PDF knowledge base (Phase 2)</li>
          <li>\u2022 Connect Google Calendar for booking tools (Phase 2)</li>
          <li>\u2022 Test a mock call and review the transcript (Phase 3)</li>
          <li>\u2022 Configure compliance: consent, DNC, opt-out (Phase 6)</li>
          <li>\u2022 Brand your client dashboard (Phase 8)</li>
        </ul>
      </Card>
    </div>
  );
}
