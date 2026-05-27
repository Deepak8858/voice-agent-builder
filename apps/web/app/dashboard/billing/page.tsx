import { apiFetch } from '@/lib/api';
import { BillingPanel } from '@/components/billing-panel';
import { InvoiceHistory } from '@/components/invoice-history';
import { PageHeader } from '@/components/dashboard';
import type { SessionUser } from '@voiceforge/shared';

export default async function BillingPage() {
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
          eyebrow="Workspace billing"
          title="Billing"
          description={
            <>
              Could not load billing:{' '}
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
        eyebrow="Workspace billing"
        title="Billing"
        description="Subscription plans, voice minute usage, invoice history, and account-level billing controls."
      />

      <BillingPanel workspaceId={me.active_workspace_id ?? ''} />

      <InvoiceHistory workspaceId={me.active_workspace_id ?? ''} />
    </div>
  );
}
