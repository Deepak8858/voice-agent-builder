'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useApi } from '@/lib/use-api';
import { isPaidPlan, type SessionUser, type SubscriptionDto } from '@voiceforge/shared';
import { CheckCircle2, Loader2 } from 'lucide-react';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;

/**
 * Dodo-hosted Checkout redirects here through its `return_url`, appending
 * whichever params it has for the purchase — `payment_id`, sometimes
 * `subscription_id` and `status`. Nothing on this page depends on any of them
 * being present: they are never trusted for activation (that work happens in
 * the webhook service) and are shown only as a support reference. Activation is
 * proven by polling the workspace subscription endpoint until either the plan
 * transitions to a paid plan/active status or we time out, so a redirect with
 * no params at all still renders a correct page.
 */
function CheckoutSuccessInner() {
  const search = useSearchParams();
  const paymentReference =
    search?.get('payment_id') ?? search?.get('subscription_id') ?? null;
  const { call } = useApi();

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionDto | null>(null);
  const [pending, setPending] = useState(true);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await call<SessionUser>('/auth/me');
        if (!cancelled) setWorkspaceId(me.active_workspace_id ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load account.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [call]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const start = Date.now();

    async function tick() {
      try {
        const sub = await call<SubscriptionDto | null>(
          `/workspaces/${workspaceId}/billing/subscription`,
        );
        if (cancelled) return;
        setSubscription(sub);
        const ready = Boolean(sub && isPaidPlan(sub.plan) && sub.status === 'active');
        if (ready) {
          setPending(false);
          return;
        }
        if (Date.now() - start > POLL_TIMEOUT_MS) {
          setTimedOut(true);
          setPending(false);
          return;
        }
        setTimeout(tick, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch subscription.');
        setPending(false);
      }
    }
    tick();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, call]);

  const headline = useMemo(() => {
    if (error) return 'Something went wrong';
    if (pending) return 'Activating your plan';
    if (timedOut) return 'Payment received — activation in progress';
    if (subscription && isPaidPlan(subscription.plan)) return `You're on the ${subscription.plan} plan`;
    return 'Payment received';
  }, [error, pending, timedOut, subscription]);

  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-2xl flex-col items-center justify-center px-6 py-16 text-center">
      <Card className="w-full overflow-hidden bg-card/95 shadow-sm">
        <CardContent className="flex flex-col items-center gap-4 p-10">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
            {pending ? <Loader2 className="h-6 w-6 animate-spin" /> : <CheckCircle2 className="h-7 w-7" />}
          </div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">{headline}</h1>
          {pending ? (
            <p className="text-sm text-muted-foreground">
              Confirming the payment with Dodo Payments and switching on the new plan. This usually
              takes a few seconds.
            </p>
          ) : timedOut ? (
            <p className="text-sm text-muted-foreground">
              Dodo Payments confirmed your payment but activation hasn’t finished yet. Refresh in a
              minute or open the billing page to see the latest status.
            </p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your plan limits, agents, and call minutes have been updated. Head back to the dashboard to
              keep building.
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard/billing">Open billing</Link>
            </Button>
          </div>
          {paymentReference ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Payment reference:{' '}
              <code className="rounded bg-muted px-1 py-0.5">{paymentReference}</code>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex min-h-[70dvh] max-w-2xl items-center justify-center px-6 py-16 text-center">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <CheckoutSuccessInner />
    </Suspense>
  );
}
