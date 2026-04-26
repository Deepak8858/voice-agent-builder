import { apiFetch } from '@/lib/api';
import { KnowledgePanel } from '@/components/knowledge-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function KnowledgePage() {
  const me = await apiFetch<SessionUser>('/auth/me');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Knowledge
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Workspace-level knowledge sources. Agents can reference these in addition to
          their own agent-scoped sources.
        </p>
      </header>

      <KnowledgePanel
        workspaceId={me.active_workspace_id}
        agentId={null}
        title="Workspace knowledge"
      />
    </div>
  );
}
