'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  BillingStatusDtoSchema,
  BillingSummaryDtoSchema,
  MINUTE_PACK,
  PLAN_CATALOG,
  getPlanById,
  getPlanEntitlements,
  getUpgradeTarget,
  hasLiveSubscription,
  isPaidPlan,
  SubscriptionDtoSchema,
  WorkspaceUsageDtoSchema,
  type CheckoutPlan,
  type PlanType,
} from '@voiceforge/shared';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  BILLING_DISCLOSURES,
  CHECKOUT_UNAVAILABLE_MESSAGE,
  CHECKOUT_UNAVAILABLE_TITLE,
  MINUTE_PACK_LABEL,
} from '@/lib/billing-copy';
import { formatBalance, toBalanceBuckets } from '@/lib/billing-summary';
import { useApi } from '@/lib/use-api';
import { CreditCard, ExternalLink, CheckCircle2, Wallet, XCircle } from 'lucide-react';
import posthog from 'posthog-js';
import { z } from 'zod';

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
  tools: 'Integration connections',
  agents: 'Agents',
};

const RedirectResponseSchema = z.object({ url: z.string().url() }).strict();

function isTrustedCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (
      u.hostname === 'checkout.dodopayments.com' ||
      u.hostname.endsWith('.dodopayments.com')
    );
  } catch {
    return false;
  }
}

export function BillingPanel({ workspaceId }: BillingPanelProps) {
  const { call } = useApi();
  const search = useSearchParams();
  const checkoutBanner = search?.get('checkout') ?? search?.get('topup') ?? null;
  const [dismissedBanner, setDismissedBanner] = useState(false);

  const subscription = useQuery({
    queryKey: ['billing', 'subscription', workspaceId],
    queryFn: async () => SubscriptionDtoSchema.nullable().parse(
      await call<unknown>(`/workspaces/${workspaceId}/billing/subscription`),
    ),
  });

  const billingStatus = useQuery({
    queryKey: ['billing', 'status', workspaceId],
    queryFn: async () => BillingStatusDtoSchema.parse(
      await call<unknown>(`/workspaces/${workspaceId}/billing/status`),
    ),
  });

  const usage = useQuery({
    queryKey: ['billing', 'usage', workspaceId],
    queryFn: async () => WorkspaceUsageDtoSchema.parse(
      await call<unknown>(`/workspaces/${workspaceId}/billing/usage`),
    ),
  });

  // Organization-scoped credit balances. The endpoint ships with the billing
  // service work; until then it 404s and the card renders an explicit
  // "not available yet" state instead of inventing numbers.
  const summary = useQuery({
    queryKey: ['billing', 'summary', workspaceId],
    queryFn: async () => BillingSummaryDtoSchema.parse(
      await call<unknown>(`/workspaces/${workspaceId}/billing/summary`),
    ),
    retry: false,
  });

  // After Dodo Payments redirects back to /dashboard/billing?checkout=success (or
  // ?topup=success) the webhook may not have fired yet. Refetch so the user
  // sees the new plan and balance as soon as the webhook lands.
  useEffect(() => {
    if (checkoutBanner === 'success') {
      void subscription.refetch();
      void usage.refetch();
      void summary.refetch();
    }
    // refetch is stable; eslint can't tell because it's destructured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutBanner]);

  const plan: PlanType = (subscription.data?.plan as PlanType | undefined) ?? 'free';
  const planEntry = useMemo(() => getPlanById(plan), [plan]);
  // A second subscription Checkout is refused by the API whenever the provider
  // still holds a live subscription, because it would create a second one and
  // bill twice. Rendering "Upgrade" there would hand a paying customer a button
  // that can only return 400; plan changes go through the portal instead, which
  // is the button already shown beside it.
  // Read straight off the query rather than the `status` default below: that one
  // falls back to 'active', which would read as a live subscription for a Free
  // org that has no subscription row at all and hide its only upgrade path.
  const liveSubscription = isPaidPlan(plan) && hasLiveSubscription(subscription.data?.status ?? '');
  const upgradeTarget = useMemo(
    () => (liveSubscription ? null : getUpgradeTarget(plan)),
    [plan, liveSubscription],
  );
  const upgradeEntry = useMemo(() => (upgradeTarget ? getPlanById(upgradeTarget) : null), [upgradeTarget]);

  const checkout = useMutation({
    mutationFn: async (targetPlan?: CheckoutPlan) => {
      if (billingStatus.data?.liveCheckoutEnabled === false) {
        throw new Error(CHECKOUT_UNAVAILABLE_MESSAGE);
      }
      const plan = targetPlan ?? upgradeTarget;
      if (!plan) throw new Error('No upgrade target available.');
      const data = RedirectResponseSchema.parse(await call<unknown>(
        `/workspaces/${workspaceId}/billing/checkout`,
        {
          method: 'POST',
          body: JSON.stringify({
            plan,
            idempotencyKey: crypto.randomUUID(),
            successPath: '/checkout/success',
            cancelPath: '/checkout/cancel',
          }),
        },
      ));
      if (!isTrustedCheckoutUrl(data.url)) {
        throw new Error('Untrusted redirect URL received from server');
      }
      posthog.capture('checkout_started', { plan });
      window.location.href = data.url;
    },
  });

  const topUp = useMutation({
    mutationFn: async () => {
      if (billingStatus.data?.topUpEnabled === false) {
        throw new Error(CHECKOUT_UNAVAILABLE_MESSAGE);
      }
      // The pack price id is resolved server-side on purpose: a client-supplied
      // price would let a caller buy minutes at a price of their choosing.
      const data = RedirectResponseSchema.parse(await call<unknown>(
        `/workspaces/${workspaceId}/billing/topup-checkout`,
        {
          method: 'POST',
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            successPath: '/dashboard/billing?topup=success',
            cancelPath: '/dashboard/billing?topup=cancel',
          }),
        },
      ));
      if (!isTrustedCheckoutUrl(data.url)) {
        throw new Error('Untrusted redirect URL received from server');
      }
      posthog.capture('topup_checkout_started', { minutes: MINUTE_PACK.minutes });
      window.location.href = data.url;
    },
  });

  const portal = useMutation({
    mutationFn: async () => {
      if (billingStatus.data?.portalEnabled === false) {
        throw new Error(CHECKOUT_UNAVAILABLE_MESSAGE);
      }
      const data = RedirectResponseSchema.parse(await call<unknown>(
        `/workspaces/${workspaceId}/billing/portal`,
        {
          method: 'POST',
          body: JSON.stringify({ returnPath: '/dashboard/billing' }),
        },
      ));
      if (!isTrustedCheckoutUrl(data.url)) {
        throw new Error('Untrusted redirect URL received from server');
      }
      posthog.capture('billing_portal_opened');
      window.location.href = data.url;
    },
  });

  const status = subscription.data?.status ?? 'active';
  const limits = usage.data?.limits ?? {};
  const metrics = usage.data?.usage ?? {};

  const planLabel = planEntry?.name ?? plan;
  const billingStatusLoading = billingStatus.isLoading;
  // Each action has its own server-side configuration and fails independently:
  // a deployment missing only the minute-pack price can still take upgrades.
  // Gating all three on one flag turned one unset variable into zero revenue.
  const liveBillingEnabled = billingStatus.data?.liveCheckoutEnabled === true;
  const topUpEnabled = billingStatus.data?.topUpEnabled === true;
  const portalEnabled = billingStatus.data?.portalEnabled === true;
  const checkoutDisabled = billingStatusLoading || !liveBillingEnabled;
  const topUpDisabled = billingStatusLoading || !topUpEnabled;
  const portalDisabled = billingStatusLoading || !portalEnabled;
  const buckets = summary.data ? toBalanceBuckets(summary.data) : null;
  // Packs top up an existing paid subscription; they are not a way to buy
  // telephony minutes without a plan.
  const topUpAllowed =
    summary.data?.topUpAvailable ?? (isPaidPlan(plan) && status === 'active');
  const freeMonthlyMinutes = getPlanEntitlements('free').includedMinutes;

  return (
    <div className="flex flex-col gap-8">
      {!billingStatusLoading && !liveBillingEnabled ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-sm text-amber-900 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">{CHECKOUT_UNAVAILABLE_TITLE}</p>
          <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-100/80">
            {CHECKOUT_UNAVAILABLE_MESSAGE}
          </p>
        </div>
      ) : null}

      {!dismissedBanner && checkoutBanner === 'success' ? (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-900 shadow-sm dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100">
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-300" />
          <div className="flex-1">
            <p className="font-medium">Payment received by Dodo Payments</p>
            <p className="mt-0.5 text-xs text-emerald-800/90 dark:text-emerald-100/80">
              Credits and plan changes appear after Dodo&apos;s webhook is verified — usually within
              a few seconds. If the balance still looks unchanged, reload the page.
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
                disabled={checkout.isPending || checkoutDisabled}
              >
                {billingStatusLoading
                  ? 'Checking billing...'
                  : !liveBillingEnabled
                  ? 'Checkout unavailable'
                  : checkout.isPending
                  ? 'Redirecting…'
                  : `Upgrade to ${upgradeEntry.name}`}
              </Button>
            ) : null}
            {isPaidPlan(plan) ? (
              <Button
                variant="outline"
                onClick={() => portal.mutate()}
                disabled={portal.isPending || portalDisabled}
                className="gap-2"
              >
                {billingStatusLoading
                  ? 'Checking billing...'
                  : !portalEnabled
                  ? 'Portal unavailable'
                  : portal.isPending
                  ? 'Redirecting…'
                  : 'Manage subscription'}
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

      {/* Balances */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Minute balance
          </CardTitle>
          <CardDescription className="mt-1">
            Balances are shared across every workspace in your organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {summary.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : buckets ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {buckets.map((bucket) => (
                <div key={bucket.label} className="rounded-lg border border-border p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {bucket.label}
                  </p>
                  <p className="mt-1 font-mono text-2xl font-semibold text-foreground">
                    {formatBalance(bucket.seconds)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{bucket.hint}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Balance details are not available yet. Usage below still reflects this period.
            </p>
          )}

          {/* Free's browser tests are funded by the same balance shown above, so
              the buckets are the only readout needed — there is no separate
              lifetime test allowance to report. */}
          {plan === 'free' ? (
            <p className="text-xs text-muted-foreground">
              Browser tests draw from your {freeMonthlyMinutes} included minutes, which reset each
              month and do not accumulate.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => topUp.mutate()}
              disabled={topUp.isPending || topUpDisabled || !topUpAllowed}
            >
              {billingStatusLoading
                ? 'Checking billing...'
                : !topUpEnabled
                ? 'Packs unavailable'
                : topUp.isPending
                ? 'Redirecting…'
                : MINUTE_PACK_LABEL}
            </Button>
            <p className="text-xs text-muted-foreground">
              {topUpAllowed
                ? `Packs expire ${MINUTE_PACK.expiresAfterDays} days after purchase and are used after included minutes.`
                : `A paid plan with an active subscription is required to buy ${MINUTE_PACK.minutes}-minute packs.`}
            </p>
          </div>
          {topUp.isError ? (
            <p className="text-xs text-destructive">{(topUp.error as Error)?.message}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* Upgrade callout for the browser-test-only plan */}
      {plan === 'free' && status === 'active' ? (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/50">
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-300">
                Browser test only
              </Badge>
              <p className="text-sm text-foreground">
                Free includes {freeMonthlyMinutes} browser test minutes a month but has no phone
                number, so it cannot place PSTN calls. Upgrade to {PLAN_CATALOG[1].name} for
                telephony minutes, more agents, and integrations.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => checkout.mutate('starter')}
              disabled={checkout.isPending || checkoutDisabled}
            >
              {billingStatusLoading
                ? 'Checking billing...'
                : !liveBillingEnabled
                ? 'Checkout unavailable'
                : checkout.isPending
                ? 'Redirecting…'
                : `Upgrade to ${PLAN_CATALOG[1].name}`}
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
              const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
              return (
                <Card key={key}>
                  <CardContent className="pt-6">
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{METRIC_LABELS[key]}</span>
                      <span className="font-medium text-foreground font-mono">
                        {used} / {limit}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {limit > 0 ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">{pct.toFixed(0)}% used</p>
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

      {/* Billing rules that apply to every metered call */}
      <div>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          How your minutes are charged
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {BILLING_DISCLOSURES.map((disclosure) => (
            <li key={disclosure} className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
              {disclosure}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
