'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  PLAN_CATALOG,
  getPlanById,
  getUpgradeTarget,
  isPaidPlan,
  type CheckoutPlan,
  type PlanType,
  type SubscriptionDto,
  type WorkspaceUsageDto,
} from '@voiceforge/shared';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/use-api';
import { CreditCard, ExternalLink, CheckCircle2, XCircle } from 'lucide-react';

interface BillingPanelProps {
  workspaceId: string;
}

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

export function BillingPanel({ workspaceId }: BillingPanelProps) {
  const { call } = useApi();
  const search = useSearchParams();
  const checkoutBanner = search?.get('checkout') ?? null;
  const [dismissedBanner, setDismissedBanner] = useState(false);

  const subscription = useQuery({
    queryKey: ['billing', 'subscription', workspaceId],
    queryFn: () => call<SubscriptionDto | null>(`/workspaces/${workspaceId}/billing/subscription`),
  });

  const usage = useQuery({
    queryKey: ['billing', 'usage', workspaceId],
    queryFn: () => call<WorkspaceUsageDto>(`/workspaces/${workspaceId}/billing/usage`),
  });

  // After Stripe redirects back to /dashboard/billing?checkout=success the
  // webhook may not have fired yet. Refetch subscription and usage so the
  // user sees the new plan as soon as the webhook lands.
  useEffect(() => {
    if (checkoutBanner === 'success') {
      void subscription.refetch();
      void usage.refetch();
    }
    // refetch is stable; eslint can't tell because it's destructured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutBanner]);

  const plan: PlanType = (subscription.data?.plan as PlanType | undefined) ?? 'free';
  const planEntry = useMemo(() => getPlanById(plan), [plan]);
  const upgradeTarget = useMemo(() => getUpgradeTarget(plan), [plan]);
  const upgradeEntry = useMemo(() => (upgradeTarget ? getPlanById(upgradeTarget) : null), [upgradeTarget]);

  const checkout = useMutation({
    mutationFn: async (targetPlan?: CheckoutPlan) => {
      const plan = targetPlan ?? upgradeTarget;
      if (!plan) throw new Error('No upgrade target available.');
      const data = await call<{ url: string }>(`/workspaces/${workspaceId}/billing/checkout`, {
        method: 'POST',
        body: JSON.stringify({
          plan,
          successPath: '/checkout/success',
          cancelPath: '/checkout/cancel',
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
        body: JSON.stringify({ returnPath: '/dashboard/billing' }),
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

  const planLabel = planEntry?.name ?? plan;

  return (
    <div className="flex flex-col gap-8">
      {!dismissedBanner && checkoutBanner === 'success' ? (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-900 shadow-sm dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100">
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-300" />
          <div className="flex-1">
            <p className="font-medium">Payment received</p>
            <p className="mt-0.5 text-xs text-emerald-800/90 dark:text-emerald-100/80">
              Stripe confirmed your payment. Your new plan limits will apply as soon as the webhook lands
              — usually within seconds.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setDismissedBanner(true)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {!dismissedBanner && checkoutBanner === 'cancel' ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-sm text-amber-900 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          <XCircle className="mt-0.5 h-4 w-4 text-amber-700 dark:text-amber-300" />
          <div className="flex-1">
            <p className="font-medium">Checkout cancelled</p>
            <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-100/80">
              You haven’t been charged. You can pick a plan again any time.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setDismissedBanner(true)}>
            Dismiss
          </Button>
        </div>
      ) : null}

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
          <Badge className={PLAN_COLORS[plan] ?? PLAN_COLORS.free}>{planLabel}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status:</span>
            <span className="font-medium capitalize text-foreground">{status}</span>
          </div>
          <div className="flex flex-wrap gap-3">
            {upgradeTarget && upgradeEntry ? (
              <Button
                onClick={() => checkout.mutate(upgradeTarget)}
                disabled={checkout.isPending}
              >
                {checkout.isPending
                  ? 'Redirecting…'
                  : `Upgrade to ${upgradeEntry.name}`}
              </Button>
            ) : null}
            {isPaidPlan(plan) ? (
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
            <Button asChild variant="ghost">
              <a href="/pricing">Compare plans</a>
            </Button>
          </div>
          {checkout.isError ? (
            <p className="text-xs text-destructive">{(checkout.error as Error)?.message}</p>
          ) : null}
          {['past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(status) ? (
            <p className="text-xs text-destructive">
              Payment needs attention. Open the customer portal to update payment details or resolve the
              invoice.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Free trial callout for free plan */}
      {plan === 'free' && status === 'active' ? (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/50">
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-300">
                Free trial
              </Badge>
              <p className="text-sm text-foreground">
                Upgrade to {PLAN_CATALOG[1].name} to unlock outbound minutes, more agents, and integrations.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => checkout.mutate('starter')}
              disabled={checkout.isPending}
            >
              {checkout.isPending ? 'Redirecting…' : `Upgrade to ${PLAN_CATALOG[1].name}`}
            </Button>
          </CardContent>
        </Card>
      ) : null}

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
