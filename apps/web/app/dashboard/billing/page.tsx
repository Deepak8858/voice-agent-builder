import { apiFetch } from '@/lib/api';
import { BillingPanel } from '@/components/billing-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function BillingPage() {
  const me = await apiFetch<SessionUser>('/auth/me');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Billing
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Subscription plans, voice minute usage, and invoice history.
        </p>
      </header>

      <BillingPanel workspaceId={me.active_workspace_id} />
    </div>
  );
}
