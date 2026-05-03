'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import type { SubscriptionDto, WorkspaceUsageDto } from '@voiceforge/shared';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/use-api';
import { CreditCard, ExternalLink } from 'lucide-react';

interface BillingPanelProps {
  workspaceId: string;
  priceIds?: {
    starter: string | null;
    growth: string | null;
    enterprise: string | null;
  };
}

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  growth: 'Growth',
  enterprise: 'Enterprise',
};

const PLAN_COLORS: Record<string, string> = {
  free: 'bg-muted text-muted-foreground',
  starter: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  growth: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  enterprise: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
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

export function BillingPanel({ workspaceId, priceIds }: BillingPanelProps) {
  const { call } = useApi();

  const subscription = useQuery({
    queryKey: ['billing', 'subscription', workspaceId],
    queryFn: () => call<SubscriptionDto | null>(`/workspaces/${workspaceId}/billing/subscription`),
  });

  const usage = useQuery({
    queryKey: ['billing', 'usage', workspaceId],
    queryFn: () => call<WorkspaceUsageDto>(`/workspaces/${workspaceId}/billing/usage`),
  });

  const plan = subscription.data?.plan ?? 'free';

  const getPriceIdForPlan = (targetPlan: string): string | null => {
    if (targetPlan === 'starter') return priceIds?.starter ?? null;
    if (targetPlan === 'growth') return priceIds?.growth ?? null;
    if (targetPlan === 'enterprise') return priceIds?.enterprise ?? null;
    return null;
  };

  const upgradeToPlan = (currentPlan: string): string => {
    if (currentPlan === 'free') return 'starter';
    if (currentPlan === 'starter') return 'growth';
    if (currentPlan === 'growth') return 'enterprise';
    return 'growth';
  };

  const checkout = useMutation({
    mutationFn: async () => {
      const targetPlan = upgradeToPlan(plan);
      const selectedPriceId = getPriceIdForPlan(targetPlan);
      const data = await call<{ url: string }>(`/workspaces/${workspaceId}/billing/checkout`, {
        method: 'POST',
        body: JSON.stringify({
          priceId: selectedPriceId ?? 'price_1',
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

  const status = subscription.data?.status ?? 'active';
  const limits = usage.data?.limits ?? {};
  const metrics = usage.data?.usage ?? {};

  return (
    <div className="flex flex-col gap-8">
      {/* Plan card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              Current plan
            </CardTitle>
            <CardDescription className="mt-1">
              {subscription.data?.currentPeriodEnd
                ? `Current period ends ${new Date(subscription.data.currentPeriodEnd).toLocaleDateString()}`
                : 'Manage your subscription and billing details.'}
            </CardDescription>
          </div>
          <Badge className={PLAN_COLORS[plan] ?? PLAN_COLORS.free}>
            {PLAN_LABELS[plan] ?? plan}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status:</span>
            <span className="font-medium capitalize text-foreground">{status}</span>
          </div>
          <div className="flex gap-3">
            {plan !== 'enterprise' ? (
              <Button
                onClick={() => checkout.mutate()}
                disabled={checkout.isPending}
              >
                {checkout.isPending ? 'Redirecting…' : 'Upgrade plan'}
              </Button>
            ) : null}
            {plan !== 'free' ? (
              <Button
                variant="outline"
                onClick={() => portal.mutate()}
                disabled={portal.isPending}
                className="gap-2"
              >
                {portal.isPending ? 'Redirecting…' : 'Manage subscription'}
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
          {checkout.isError ? (
            <p className="text-xs text-destructive">{(checkout.error as Error)?.message}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* Usage meters */}
      <div>
        <h2 className="mb-4 text-sm font-medium text-muted-foreground uppercase tracking-wider">Usage this period</h2>
        {usage.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : usage.data ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(['calls', 'minutes', 'tools', 'agents'] as const).map((key) => {
              const used = metrics[key] ?? 0;
              const limit = limits[key] ?? 0;
              const unlimited = limit === -1;
              const pct = unlimited ? 0 : limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
              return (
                <Card key={key}>
                  <CardContent className="pt-6">
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{METRIC_LABELS[key]}</span>
                      <span className="font-medium text-foreground font-mono">
                        {used}
                        {unlimited ? '' : ` / ${limit}`}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${unlimited ? 0 : pct}%` }}
                      />
                    </div>
                    {!unlimited && limit > 0 ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">{pct.toFixed(0)}% used</p>
                    ) : unlimited ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">Unlimited</p>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-destructive">Failed to load usage.</p>
        )}
      </div>
    </div>
  );
}
