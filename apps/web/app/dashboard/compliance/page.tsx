import { apiFetch } from '@/lib/api';
import { CompliancePanel } from '@/components/compliance-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function CompliancePage() {
  const me = await apiFetch<SessionUser>('/auth/me');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Compliance
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Manage contacts, consent records, and the workspace Do-Not-Call list. Outbound
          calls are gated on these checks.
        </p>
      </header>

      <CompliancePanel workspaceId={me.active_workspace_id} />
    </div>
  );
}
