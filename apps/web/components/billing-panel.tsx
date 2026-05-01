'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanType, SubscriptionDto, WorkspaceUsageDto } from '@voiceforge/shared';
import { Badge, Card, CardHeader, CardTitle } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/use-api';

interface BillingPanelProps {
  workspaceId: string;
  priceIds: {
    starter: string | null;
    growth: string | null;
    enterprise: string | null;
  };
}

interface PlanCard {
  id: PlanType;
  name: string;
  price: string;
  highlights: string[];
  priceId: string | null;
}

const PLAN_CARDS = (priceIds: BillingPanelProps['priceIds']): PlanCard[] => [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    highlights: ['1 agent', 'No outbound calls', 'Basic templates'],
    priceId: null,
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '$49 / mo',
    highlights: ['3 agents', '100 outbound calls / mo', '300 voice minutes', '5 tools'],
    priceId: priceIds.starter,
  },
  {
    id: 'growth',
    name: 'Growth',
    price: '$199 / mo',
    highlights: ['10 agents', '500 calls / mo', '2,000 minutes', 'White-label', 'Compliance gating'],
    priceId: priceIds.growth,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    highlights: ['Unlimited agents', 'Unlimited minutes', 'SSO + audit', 'Dedicated support'],
    priceId: priceIds.enterprise,
  },
];

export function BillingPanel({ workspaceId, priceIds }: BillingPanelProps) {
  const { call } = useApi();
  const qc = useQueryClient();

  const sub = useQuery({
    queryKey: ['billing', 'subscription', workspaceId],
    queryFn: () => call<SubscriptionDto | null>(`/${workspaceId}/billing/subscription`),
  });

  const usage = useQuery({
    queryKey: ['billing', 'usage', workspaceId],
    queryFn: () => call<WorkspaceUsageDto>(`/${workspaceId}/billing/usage`),
  });

  const checkout = useMutation({
    mutationFn: async (priceId: string) => {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      return call<{ url: string }>(`/${workspaceId}/billing/checkout`, {
        method: 'POST',
        body: JSON.stringify({
          priceId,
          successUrl: `${origin}/dashboard/billing?checkout=success`,
          cancelUrl: `${origin}/dashboard/billing?checkout=cancel`,
        }),
      });
    },
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  const portal = useMutation({
    mutationFn: async () => {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      return call<{ url: string }>(`/${workspaceId}/billing/portal`, {
        method: 'POST',
        body: JSON.stringify({ returnUrl: `${origin}/dashboard/billing` }),
      });
    },
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  const currentPlan = (sub.data?.plan ?? 'free') as PlanType;
  const status = sub.data?.status ?? 'active';
  const periodEnd = sub.data?.currentPeriodEnd
    ? new Date(sub.data.currentPeriodEnd).toLocaleDateString()
    : null;
  const cancelAtEnd = sub.data?.cancelAtPeriodEnd ?? false;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Current subscription</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-2 px-6 pb-6 text-sm">
          {sub.isLoading ? (
            <p className="text-zinc-500">Loading…</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold capitalize text-zinc-900 dark:text-zinc-50">
                  {currentPlan}
                </span>
                <Badge>{status}</Badge>
                {cancelAtEnd ? <Badge>cancel at period end</Badge> : null}
              </div>
              {periodEnd ? (
                <p className="text-zinc-500">
                  Current period ends {periodEnd}.
                </p>
              ) : null}
              {sub.data?.stripeCustomerId ? (
                <Button
                  className="mt-2 w-fit"
                  onClick={() => portal.mutate()}
                  disabled={portal.isPending}
                >
                  {portal.isPending ? 'Opening portal…' : 'Manage in Stripe'}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage this period</CardTitle>
        </CardHeader>
        <div className="grid grid-cols-2 gap-4 px-6 pb-6 text-sm sm:grid-cols-4">
          {usage.isLoading ? (
            <p className="col-span-4 text-zinc-500">Loading…</p>
          ) : (
            (['calls', 'minutes', 'tools', 'agents'] as const).map((metric) => {
              const used = usage.data?.usage?.[metric] ?? 0;
              const limit = usage.data?.limits?.[metric] ?? 0;
              const display = limit === -1 ? '∞' : limit;
              const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              return (
                <div key={metric} className="flex flex-col gap-1">
                  <span className="text-xs uppercase text-zinc-500">{metric}</span>
                  <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                    {used} / {display}
                  </span>
                  <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${limit === -1 ? 5 : pct}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>

      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-500">Plans</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_CARDS(priceIds).map((plan) => {
            const isCurrent = plan.id === currentPlan;
            return (
              <Card key={plan.id} className={isCurrent ? 'ring-2 ring-emerald-500' : ''}>
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                </CardHeader>
                <div className="flex flex-col gap-3 px-6 pb-6 text-sm">
                  <span className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                    {plan.price}
                  </span>
                  <ul className="flex flex-col gap-1 text-zinc-600 dark:text-zinc-400">
                    {plan.highlights.map((h) => (
                      <li key={h}>• {h}</li>
                    ))}
                  </ul>
                  {isCurrent ? (
                    <Badge>Current plan</Badge>
                  ) : plan.priceId ? (
                    <Button
                      onClick={() => checkout.mutate(plan.priceId!)}
                      disabled={checkout.isPending}
                    >
                      {checkout.isPending ? 'Redirecting…' : `Upgrade to ${plan.name}`}
                    </Button>
                  ) : plan.id === 'enterprise' ? (
                    <a
                      className="text-sm font-medium text-emerald-600 hover:underline"
                      href="mailto:sales@voiceforge.ai?subject=Enterprise%20plan"
                    >
                      Contact sales →
                    </a>
                  ) : (
                    <span className="text-xs text-zinc-500">
                      Configure {plan.id.toUpperCase()}_PRICE_ID env var to enable.
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}
