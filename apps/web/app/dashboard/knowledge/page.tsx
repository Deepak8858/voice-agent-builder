import { apiFetch } from '@/lib/api';
import { KnowledgePanel } from '@/components/knowledge-panel';
import { PageHeader } from '@/components/dashboard';
import type { SessionUser } from '@voiceforge/shared';

export default async function KnowledgePage() {
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
          eyebrow="Knowledge base"
          title="Knowledge"
          description={
            <>
              Could not load knowledge:{' '}
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
        eyebrow="Knowledge base"
        title="Knowledge"
        description="Workspace-level knowledge sources your agents can reference in addition to their own agent-scoped sources."
      />

      <KnowledgePanel
        workspaceId={me.active_workspace_id ?? ''}
        agentId={null}
        title="Workspace knowledge"
      />
    </div>
  );
}
