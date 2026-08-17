import { Suspense } from 'react';
import { getSessionUser } from '@/lib/api';
import { WhiteLabelPanel } from '@/components/white-label-panel';
import { PageHeader } from '@/components/dashboard';
import { PanelSkeleton } from '@/components/dashboard/page-skeleton';
import { SessionErrorCard } from '@/components/dashboard/session-error-card';
import type { SessionUser } from '@voiceforge/shared';

export default function WhiteLabelPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Agency brand"
        title="White label"
        description="Brand the dashboard for your agency with a logo, primary color, custom domain, and support email."
      />

      <Suspense fallback={<PanelSkeleton />}>
        <WhiteLabelSection />
      </Suspense>
    </div>
  );
}

async function WhiteLabelSection() {
  let me: SessionUser | null = null;
  let apiError: string | null = null;
  try {
    me = await getSessionUser();
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (!me) return <SessionErrorCard title="Could not load settings" message={apiError} />;
  if (!me.active_workspace_id) {
    return (
      <SessionErrorCard title="Could not load settings" message="No active workspace selected." />
    );
  }

  return <WhiteLabelPanel workspaceId={me.active_workspace_id} />;
}
