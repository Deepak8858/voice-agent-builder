import { apiFetch } from '@/lib/api';
import { AnalyticsPanel } from '@/components/analytics-panel';
import { PageHeader } from '@/components/dashboard';
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
        <PageHeader
          eyebrow="Insights"
          title="Analytics"
          description={
            <>
              Could not load analytics:{' '}
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
        eyebrow="Insights"
        title="Analytics"
        description="Workspace and per-agent performance over the last 30 days, including compliance blocks, opt-outs, and call outcomes."
      />

      <AnalyticsPanel workspaceId={me.active_workspace_id ?? ''} />
    </div>
  );
}
