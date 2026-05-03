import { apiFetch } from '@/lib/api';
import { AnalyticsPanel } from '@/components/analytics-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function AnalyticsPage() {
  const me = await apiFetch<SessionUser>('/auth/me');

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace + per-agent performance over the last 30 days. Compliance blocks,
          opt-outs, and call outcomes are tracked here.
        </p>
      </div>

      <AnalyticsPanel workspaceId={me.active_workspace_id} />
    </div>
  );
}
