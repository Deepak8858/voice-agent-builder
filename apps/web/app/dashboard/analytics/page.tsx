import { apiFetch } from '@/lib/api';
import { AnalyticsPanel } from '@/components/analytics-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function AnalyticsPage() {
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
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Could not load analytics: <code className="text-xs bg-muted px-1 py-0.5 rounded">{apiError}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace + per-agent performance over the last 30 days. Compliance blocks,
          opt-outs, and call outcomes are tracked here.
        </p>
      </div>

      <AnalyticsPanel workspaceId={me.active_workspace_id ?? ''} />
    </div>
  );
}
