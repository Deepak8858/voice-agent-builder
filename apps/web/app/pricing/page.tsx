import { PricingPage } from '@/components/pricing-page';
import { apiFetch, ApiCallError } from '@/lib/api';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import type { PlanType, SubscriptionDto } from '@voiceforge/shared';

export const dynamic = 'force-dynamic';

export default async function Pricing() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let currentPlan: PlanType | null = null;
  if (user) {
    try {
      const me = await apiFetch<{ active_workspace_id?: string | null }>('/auth/me');
      if (me?.active_workspace_id) {
        const sub = await apiFetch<SubscriptionDto | null>(
          `/workspaces/${me.active_workspace_id}/billing/subscription`,
        );
        currentPlan = sub?.plan ?? 'free';
      } else {
        currentPlan = 'free';
      }
    } catch (err) {
      // Don't fail the public pricing page if the billing lookup throws.
      if (!(err instanceof ApiCallError)) throw err;
    }
  }

  return <PricingPage isAuthenticated={Boolean(user)} currentPlan={currentPlan} />;
}
