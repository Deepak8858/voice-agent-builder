import { apiFetch } from '@/lib/api';
import { KnowledgePanel } from '@/components/knowledge-panel';
import type { SessionUser } from '@voiceforge/shared';
import { BookOpen } from 'lucide-react';

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
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Knowledge</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Could not load knowledge: <code className="text-xs bg-muted px-1 py-0.5 rounded">{apiError}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Knowledge</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace-level knowledge sources. Agents can reference these in addition to
          their own agent-scoped sources.
        </p>
      </div>

      <KnowledgePanel
        workspaceId={me.active_workspace_id}
        agentId={null}
        title="Workspace knowledge"
      />
    </div>
  );
}
