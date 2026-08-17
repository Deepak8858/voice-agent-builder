import { Suspense } from 'react';
import { getSessionUser } from '@/lib/api';
import { BillingPanel } from '@/components/billing-panel';
import { InvoiceHistory } from '@/components/invoice-history';
import { PageHeader } from '@/components/dashboard';
import { ListSkeleton, PanelSkeleton } from '@/components/dashboard/page-skeleton';
import { SessionErrorCard } from '@/components/dashboard/session-error-card';
import type { SessionUser } from '@voiceforge/shared';

export default function BillingPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Workspace billing"
        title="Billing"
        description="Subscription plans, voice minute usage, invoice history, and account-level billing controls."
      />

      <Suspense
        fallback={
          <>
            <PanelSkeleton />
            <ListSkeleton rows={4} />
          </>
        }
      >
        <BillingSection />
      </Suspense>
    </div>
  );
}

async function BillingSection() {
  let me: SessionUser | null = null;
  let apiError: string | null = null;
  try {
    me = await getSessionUser();
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (!me) return <SessionErrorCard title="Could not load billing" message={apiError} />;

  if (!me.active_workspace_id) {
    return <SessionErrorCard title="Could not load billing" message="No active workspace selected." />;
  }

  const workspaceId = me.active_workspace_id;
  return (
    <>
      <BillingPanel workspaceId={workspaceId} />
      <InvoiceHistory workspaceId={workspaceId} />
    </>
  );
}
