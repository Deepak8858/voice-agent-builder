import { Suspense } from 'react';
import { getSessionUser } from '@/lib/api';
import { KnowledgePanel } from '@/components/knowledge-panel';
import { PageHeader } from '@/components/dashboard';
import { PanelSkeleton } from '@/components/dashboard/page-skeleton';
import { SessionErrorCard } from '@/components/dashboard/session-error-card';
import type { SessionUser } from '@voiceforge/shared';

export default function KnowledgePage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Knowledge base"
        title="Knowledge"
        description="Workspace-level knowledge sources your agents can reference in addition to their own agent-scoped sources."
      />

      <Suspense fallback={<PanelSkeleton />}>
        <KnowledgeSection />
      </Suspense>
    </div>
  );
}

async function KnowledgeSection() {
  let me: SessionUser | null = null;
  let apiError: string | null = null;
  try {
    me = await getSessionUser();
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (!me) return <SessionErrorCard title="Could not load knowledge" message={apiError} />;
  if (!me.active_workspace_id) {
    return (
      <SessionErrorCard title="Could not load knowledge" message="No active workspace selected." />
    );
  }

  return (
    <KnowledgePanel
      workspaceId={me.active_workspace_id}
      agentId={null}
      title="Workspace knowledge"
    />
  );
}
