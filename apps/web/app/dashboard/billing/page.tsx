import { apiFetch } from '@/lib/api';
import { BillingPanel } from '@/components/billing-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function BillingPage() {
  const me = await apiFetch<SessionUser>('/auth/me');

  const priceIds = {
    starter: process.env.NEXT_PUBLIC_STRIPE_STARTER_PRICE_ID ?? null,
    growth: process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID ?? null,
    enterprise: process.env.NEXT_PUBLIC_STRIPE_ENTERPRISE_PRICE_ID ?? null,
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Subscription plans, voice minute usage, and invoice history.
        </p>
      </div>

      <BillingPanel workspaceId={me.active_workspace_id} priceIds={priceIds} />
    </div>
  );
}
