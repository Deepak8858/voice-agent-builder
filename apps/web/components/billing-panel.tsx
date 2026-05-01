'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import type { SubscriptionDto, WorkspaceUsageDto } from '@voiceforge/shared';
import { Card, CardHeader, CardTitle, Badge } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

interface BillingPanelProps {
  workspaceId: string;
}

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  growth: 'Growth',
  enterprise: 'Enterprise',
};

const PLAN_COLORS: Record<string, string> = {
  free: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  starter: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  growth: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  enterprise: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
};

const METRIC_LABELS: Record<string, string> = {
  calls: 'Calls',
  minutes: 'Minutes',
  tools: 'Tool invocations',
  agents: 'Agents',
};

function isTrustedCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (
      u.hostname === 'checkout.stripe.com' ||
      u.hostname.endsWith('.stripe.com')
    );
  } catch {
    return false;
  }
}

export function BillingPanel({ workspaceId }: BillingPanelProps) {
  const { call } = useApi();

  const subscription = useQuery({
    queryKey: ['billing', 'subscription', workspaceId],
    queryFn: () => call<SubscriptionDto | null>(`/workspaces/${workspaceId}/billing/subscription`),
  });

  const usage = useQuery({
    queryKey: ['billing', 'usage', workspaceId],
    queryFn: () => call<WorkspaceUsageDto>(`/workspaces/${workspaceId}/billing/usage`),
  });

  const checkout = useMutation({
    mutationFn: async () => {
      const data = await call<{ url: string }>(`/workspaces/${workspaceId}/billing/checkout`, {
        method: 'POST',
        body: JSON.stringify({
          priceId: 'price_1', // placeholder; real Stripe price IDs come from env/config
          successUrl: `${window.location.origin}/dashboard/billing?checkout=success`,
          cancelUrl: `${window.location.origin}/dashboard/billing?checkout=cancel`,
        }),
      });
      if (!isTrustedCheckoutUrl(data.url)) {
        throw new Error('Untrusted redirect URL received from server');
      }
      window.location.href = data.url;
    },
  });

  const portal = useMutation({
    mutationFn: async () => {
      const data = await call<{ url: string }>(`/workspaces/${workspaceId}/billing/portal`, {
        method: 'POST',
        body: JSON.stringify({ returnUrl: `${window.location.origin}/dashboard/billing` }),
      });
      if (!isTrustedCheckoutUrl(data.url)) {
        throw new Error('Untrusted redirect URL received from server');
      }
      window.location.href = data.url;
    },
  });

  const plan = subscription.data?.plan ?? 'free';
  const status = subscription.data?.status ?? 'active';
  const limits = usage.data?.limits ?? {};
  const metrics = usage.data?.usage ?? {};

  return (
    <div className="flex flex-col gap-6">
      {/* Plan card */}
      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          <Badge className={PLAN_COLORS[plan] ?? PLAN_COLORS.free}>
            {PLAN_LABELS[plan] ?? plan}
          </Badge>
        </CardHeader>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">Status:</span>
            <span className="font-medium capitalize text-zinc-900 dark:text-zinc-50">{status}</span>
          </div>
          {subscription.data?.currentPeriodEnd ? (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">Current period ends:</span>
              <span className="font-medium text-zinc-900 dark:text-zinc-50">
                {new Date(subscription.data.currentPeriodEnd).toLocaleDateString()}
              </span>
            </div>
          ) : null}
          <div className="mt-2 flex gap-3">
            {plan !== 'enterprise' ? (
              <button
                onClick={() => checkout.mutate()}
                disabled={checkout.isPending}
                className="inline-flex h-9 items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {checkout.isPending ? 'Redirecting…' : 'Upgrade plan'}
              </button>
            ) : null}
            {plan !== 'free' ? (
              <button
                onClick={() => portal.mutate()}
                disabled={portal.isPending}
                className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:hover:bg-zinc-900"
              >
                {portal.isPending ? 'Redirecting…' : 'Manage subscription'}
              </button>
            ) : null}
          </div>
          {checkout.isError ? (
            <p className="text-xs text-red-600">{(checkout.error as Error)?.message}</p>
          ) : null}
        </div>
      </Card>

      {/* Usage meters */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-500">Usage this period</h2>
        {usage.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : usage.data ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(['calls', 'minutes', 'tools', 'agents'] as const).map((key) => {
              const used = metrics[key] ?? 0;
              const limit = limits[key] ?? 0;
              const unlimited = limit === -1;
              const pct = unlimited ? 0 : limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
              return (
                <Card key={key}>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="text-zinc-500">{METRIC_LABELS[key]}</span>
                    <span className="font-medium text-zinc-900 dark:text-zinc-50">
                      {used}
                      {unlimited ? '' : ` / ${limit}`}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-zinc-900 transition-all dark:bg-zinc-50"
                      style={{ width: `${unlimited ? 0 : pct}%` }}
                    />
                  </div>
                  {!unlimited && limit > 0 ? (
                    <p className="mt-1 text-xs text-zinc-500">{pct.toFixed(0)}% used</p>
                  ) : unlimited ? (
                    <p className="mt-1 text-xs text-zinc-500">Unlimited</p>
                  ) : null}
                </Card>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-red-600">Failed to load usage.</p>
        )}
      </section>
    </div>
  );
}
