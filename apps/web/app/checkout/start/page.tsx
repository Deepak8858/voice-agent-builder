'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { isCheckoutUnavailable, type CheckoutUnavailable } from '@/lib/checkout-availability';
import { CheckoutPlanSchema } from '@voiceforge/shared';

/**
 * Small client-side bouncer used immediately after sign-up (or anywhere we
 * want to deep-link into Dodo Payments Checkout for a specific plan). It posts
 * to the server-side checkout route, validates the returned URL, and redirects
 * the browser to Dodo Payments. Errors are rendered with a Retry button so the
 * user is never left on an ambiguous "Loading…" screen.
 */
function trustedCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'checkout.dodopayments.com' || u.hostname.endsWith('.dodopayments.com'))
    );
  } catch {
    return false;
  }
}

function CheckoutStartInner() {
  const router = useRouter();
  const params = useSearchParams();
  const planParam = params?.get('plan');
  const parsedPlan = CheckoutPlanSchema.safeParse(planParam);

  const [error, setError] = useState<string | null>(
    parsedPlan.success ? null : 'Missing or invalid plan id.',
  );
  const [pending, setPending] = useState(parsedPlan.success);
  const [unavailable, setUnavailable] = useState<CheckoutUnavailable | null>(null);
  const checkoutAttemptId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!parsedPlan.success) return;
    let cancelled = false;
    const plan = parsedPlan.data;
    (async () => {
      try {
        const res = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plan, idempotencyKey: checkoutAttemptId.current }),
          credentials: 'include',
        });
        const data = (await res.json().catch(() => null)) as {
          url?: string;
          error?: string;
        } | CheckoutUnavailable | null;
        if (cancelled) return;
        if (res.status === 401) {
          router.replace(`/sign-in?next=/checkout/start?plan=${plan}`);
          return;
        }
        if (isCheckoutUnavailable(data)) {
          setUnavailable(data);
          setPending(false);
          return;
        }
        if (!res.ok || !data?.url) {
          setError(data?.error ?? `Checkout failed with status ${res.status}.`);
          setPending(false);
          return;
        }
        if (!trustedCheckoutUrl(data.url)) {
          setError('Untrusted checkout URL returned from server.');
          setPending(false);
          return;
        }
        window.location.assign(data.url);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Checkout failed.');
        setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parsedPlan.success, parsedPlan.data, router]);

  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center px-6 py-16 text-center">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">
        {unavailable ? unavailable.title : 'Taking you to checkout'}
      </h1>
      {pending && !error ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Redirecting you to Dodo Payments to complete your purchase…
        </p>
      ) : null}
      {unavailable ? (
        <>
          <p className="mt-3 text-sm text-muted-foreground">{unavailable.message}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link href="/pricing">Compare plans</Link>
            </Button>
            <Button asChild variant="outline">
              <a href={unavailable.salesHref}>Contact sales</a>
            </Button>
          </div>
        </>
      ) : error ? (
        <>
          <p className="mt-3 text-sm text-destructive">{error}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link href="/pricing">Back to pricing</Link>
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function CheckoutStartPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center px-6 py-16 text-center">
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">
            Taking you to checkout
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <CheckoutStartInner />
    </Suspense>
  );
}
