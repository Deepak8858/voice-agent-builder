import { apiFetch } from '@/lib/api';
import { ClientsPanel } from '@/components/clients-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function ClientsPage() {
  const me = await apiFetch<SessionUser>('/auth/me');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Clients
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Manage client workspaces under this agency. Create child workspaces, invite client users, and
          review usage.
        </p>
      </header>

      <ClientsPanel workspaceId={me.active_workspace_id} />
    </div>
  );
}
