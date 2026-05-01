import { apiFetch } from '@/lib/api';
import { AgencyAgentsTable } from '@/components/agency-agents-table';
import type { SessionUser } from '@voiceforge/shared';

export default async function AgencyAgentsPage() {
  const me = await apiFetch<SessionUser>('/auth/me');
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Client agents
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Every agent across every client workspace under your agency.
        </p>
      </header>

      <AgencyAgentsTable workspaceId={me.active_workspace_id} />
    </div>
  );
}
