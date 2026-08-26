import { Suspense } from 'react';
import { getSessionUser } from '@/lib/api';
import { CompliancePanel } from '@/components/compliance-panel';
import { PageHeader } from '@/components/dashboard';
import { PanelSkeleton } from '@/components/dashboard/page-skeleton';
import { SessionErrorCard } from '@/components/dashboard/session-error-card';
import type { SessionUser } from '@voiceforge/shared';

export default function CompliancePage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Governance"
        title="Compliance"
        description="Manage contacts, consent records, and the workspace Do-Not-Call list. Outbound calls are gated on these checks."
      />

      <Suspense fallback={<PanelSkeleton />}>
        <ComplianceSection />
      </Suspense>
    </div>
  );
}

async function ComplianceSection() {
  let me: SessionUser | null = null;
  let apiError: string | null = null;
  try {
    me = await getSessionUser();
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (!me) return <SessionErrorCard title="Could not load compliance" message={apiError} />;

  return <CompliancePanel workspaceId={me.active_workspace_id ?? ''} />;
}
