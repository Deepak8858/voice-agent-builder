import { apiFetch } from '@/lib/api';
import { ClientsPanel } from '@/components/clients-panel';
import { PageHeader } from '@/components/dashboard';
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
        <PageHeader
          eyebrow="Agency operations"
          title="Clients"
          description={
            <>
              Could not load clients:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{apiError}</code>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Agency operations"
        title="Clients"
        description="Manage client workspaces under this agency, invite client users, and review usage across accounts."
      />

      <ClientsPanel workspaceId={me.active_workspace_id ?? ''} />
    </div>
  );
}
