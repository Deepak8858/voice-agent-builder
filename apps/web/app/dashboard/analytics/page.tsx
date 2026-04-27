import { apiFetch } from '@/lib/api';
import { AnalyticsPanel } from '@/components/analytics-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function AnalyticsPage() {
  const me = await apiFetch<SessionUser>('/auth/me');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Analytics
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Workspace + per-agent performance over the last 30 days. Compliance blocks,
          opt-outs, and call outcomes are tracked here.
        </p>
      </header>

      <AnalyticsPanel workspaceId={me.active_workspace_id} />
    </div>
  );
}
