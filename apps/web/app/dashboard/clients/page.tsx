import { apiFetch } from '@/lib/api';
import { ClientsPanel } from '@/components/clients-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function ClientsPage() {
  let me: SessionUser | null = null;
  let apiError: string | null = null;

  try {
    me = await apiFetch<SessionUser>('/auth/me');
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (apiError || !me) {
    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Clients</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Could not load clients: <code className="text-xs bg-muted px-1 py-0.5 rounded">{apiError}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Clients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage client workspaces under this agency. Create child workspaces, invite client users, and
          review usage.
        </p>
      </div>

      <ClientsPanel workspaceId={me.active_workspace_id ?? ''} />
    </div>
  );
}
