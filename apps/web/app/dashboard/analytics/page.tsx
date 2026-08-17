import { Suspense } from 'react';
import { ApiCallError, getSessionUser } from '@/lib/api';
import { redirect } from 'next/navigation';
import { AnalyticsPanel } from '@/components/analytics-panel';
import { PageHeader } from '@/components/dashboard';
import { ChartSkeleton } from '@/components/dashboard/page-skeleton';
import { SessionErrorCard } from '@/components/dashboard/session-error-card';
import type { SessionUser } from '@voiceforge/shared';

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Insights"
        title="Analytics"
        description="Workspace and per-agent performance over the last 30 days, including compliance blocks, opt-outs, and call outcomes."
      />

      <Suspense
        fallback={
          <div className="flex flex-col gap-6">
            <ChartSkeleton />
            <ChartSkeleton height={260} />
          </div>
        }
      >
        <AnalyticsSection />
      </Suspense>
    </div>
  );
}

async function AnalyticsSection() {
  // `getSessionUser` rather than `requireSessionUser`: the redirect thrown by
  // the latter is control flow, and it would be swallowed by the catch that
  // renders the error card below.
  let me: SessionUser | null = null;
  let apiError: string | null = null;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof ApiCallError && err.status === 401) {
      redirect('/sign-in?next=%2Fdashboard%2Fanalytics');
    }
    apiError = (err as Error).message;
  }

  if (!me) return <SessionErrorCard title="Could not load analytics" message={apiError} />;
  if (!me.active_workspace_id) {
    return <SessionErrorCard title="Could not load analytics" message="No active workspace selected." />;
  }

  return <AnalyticsPanel workspaceId={me.active_workspace_id} />;
}
