'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { isDemoCheckoutFallback, type DemoCheckoutFallback } from '@/lib/billing-mode';
import { CheckoutPlanSchema } from '@voiceforge/shared';

/**
 * Small client-side bouncer used immediately after sign-up (or anywhere we
 * want to deep-link into Stripe Checkout for a specific plan). It posts to
 * the server-side checkout route, validates the returned URL, and redirects
 * the browser to Stripe. Errors are rendered with a Retry button so the
 * user is never left on an ambiguous "Loading…" screen.
 */
function trustedCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'checkout.stripe.com' || u.hostname.endsWith('.stripe.com'))
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
  const [demoFallback, setDemoFallback] = useState<DemoCheckoutFallback | null>(null);

  useEffect(() => {
    if (!parsedPlan.success) return;
    let cancelled = false;
    const plan = parsedPlan.data;
    (async () => {
      try {
        const res = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plan }),
          credentials: 'include',
        });
        const data = (await res.json().catch(() => null)) as {
          url?: string;
          error?: string;
        } | DemoCheckoutFallback | null;
        if (cancelled) return;
        if (res.status === 401) {
          router.replace(`/sign-in?next=/checkout/start?plan=${plan}`);
          return;
        }
        if (isDemoCheckoutFallback(data)) {
          setDemoFallback(data);
          setPending(false);
          return;
        }
        if (!res.ok || !data?.url) {
          setError(data?.error ?? `Checkout failed with status ${res.status}.`);
          setPending(false);
          return;
        }
        if (!trustedCheckoutUrl(data.url)) {
          setError('Untrusted Stripe URL returned from server.');
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
        {demoFallback ? 'Checkout is paused for demo' : 'Taking you to checkout'}
      </h1>
      {pending && !error ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Redirecting you to Stripe to complete your purchase…
        </p>
      ) : null}
      {demoFallback ? (
        <>
          <p className="mt-3 text-sm text-muted-foreground">{demoFallback.message}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link href={demoFallback.fallbackHref}>{demoFallback.fallbackLabel}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/pricing">Compare plans</Link>
            </Button>
            <Button asChild variant="ghost">
              <a href={demoFallback.salesHref}>Contact sales</a>
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
