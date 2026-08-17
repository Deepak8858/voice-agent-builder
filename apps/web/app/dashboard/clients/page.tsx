import { Suspense } from 'react';
import { getSessionUser } from '@/lib/api';
import { ClientsPanel } from '@/components/clients-panel';
import { PageHeader } from '@/components/dashboard';
import { PanelSkeleton } from '@/components/dashboard/page-skeleton';
import { SessionErrorCard } from '@/components/dashboard/session-error-card';
import type { SessionUser } from '@voiceforge/shared';

export default function ClientsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Agency operations"
        title="Clients"
        description="Manage client workspaces under this agency, invite client users, and review usage across accounts."
      />

      <Suspense fallback={<PanelSkeleton />}>
        <ClientsSection />
      </Suspense>
    </div>
  );
}

async function ClientsSection() {
  let me: SessionUser | null = null;
  let apiError: string | null = null;
  try {
    me = await getSessionUser();
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (!me) return <SessionErrorCard title="Could not load clients" message={apiError} />;

  return <ClientsPanel workspaceId={me.active_workspace_id ?? ''} />;
}
