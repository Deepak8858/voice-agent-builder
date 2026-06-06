'use client';

import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  isDemoCheckoutFallback,
  type DemoCheckoutFallback,
  type WebBillingMode,
} from '@/lib/billing-mode';
import { Check, ArrowRight, Zap } from 'lucide-react';
import {
  PLAN_CATALOG,
  comparePlans,
  isCheckoutPlan,
  type CheckoutPlan,
  type PlanCatalogEntry,
  type PlanType,
} from '@voiceforge/shared';

const SALES_EMAIL =
  process.env.NEXT_PUBLIC_SALES_EMAIL ?? 'sales@voiceforge.ai';

interface PricingPageProps {
  isAuthenticated?: boolean;
  currentPlan?: PlanType | null;
  billingMode?: WebBillingMode;
}

interface ResolvedCta {
  label: string;
  variant: 'default' | 'outline' | 'secondary';
  disabled?: boolean;
  href?: string;
  onClick?: () => void;
}

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

const FEATURE_COMPARISON = [
  { feature: 'Voice minutes', free: '10 trial', starter: '300/mo', growth: '2,000/mo', enterprise: 'Unlimited' },
  { feature: 'Agents', free: '1', starter: '3', growth: '10', enterprise: 'Unlimited' },
  { feature: 'Outbound calls', free: '5 trial', starter: '100/mo', growth: '500/mo', enterprise: 'Unlimited' },
  { feature: 'Workspaces', free: '1', starter: '2', growth: '5', enterprise: 'Unlimited' },
  { feature: 'Tools per agent', free: '2', starter: '5', growth: '20', enterprise: 'Unlimited' },
  { feature: 'Contacts', free: '50', starter: '500', growth: '5,000', enterprise: 'Unlimited' },
  { feature: 'White-label', free: false, starter: 'Subdomain', growth: 'Custom domain', enterprise: 'Custom domain' },
  { feature: 'API access', free: false, starter: true, growth: true, enterprise: true },
  { feature: 'Bulk import', free: false, starter: false, growth: true, enterprise: true },
  { feature: 'Advanced compliance', free: false, starter: false, growth: true, enterprise: true },
  { feature: 'Calendar integrations', free: false, starter: false, growth: true, enterprise: true },
  { feature: 'HIPAA-ready', free: false, starter: false, growth: false, enterprise: true },
  { feature: 'SSO / SAML', free: false, starter: false, growth: false, enterprise: true },
];

function CheckIcon({ value }: { value: boolean | string }) {
  if (value === true) return <Check className="h-4 w-4 text-primary mx-auto" />;
  if (value === false) return <span className="text-muted-foreground text-xs">—</span>;
  return <span className="text-xs text-muted-foreground">{value}</span>;
}

async function startStripeCheckout(plan: CheckoutPlan): Promise<string | DemoCheckoutFallback> {
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan }),
    credentials: 'include',
  });
  const data = (await res.json().catch(() => null)) as
    | { url?: string; error?: string }
    | DemoCheckoutFallback
    | null;
  if (isDemoCheckoutFallback(data)) {
    return data;
  }
  if (!res.ok || !data?.url) {
    throw new Error(data?.error ?? `Checkout failed with status ${res.status}.`);
  }
  if (!trustedCheckoutUrl(data.url)) {
    throw new Error('Untrusted Stripe URL returned from server.');
  }
  return data.url;
}

export function PricingPage({
  isAuthenticated = false,
  currentPlan = null,
  billingMode = 'live',
}: PricingPageProps) {
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutFallback, setCheckoutFallback] = useState<DemoCheckoutFallback | null>(null);
  const isDemoBilling = billingMode === 'demo';

  const handleCheckout = useCallback(async (plan: CheckoutPlan) => {
    setLoadingPlan(plan);
    setError(null);
    setCheckoutFallback(null);
    try {
      const result = await startStripeCheckout(plan);
      if (typeof result === 'string') {
        window.location.assign(result);
        return;
      }
      setCheckoutFallback(result);
      setLoadingPlan(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed.');
      setLoadingPlan(null);
    }
  }, []);

  const resolveCta = useMemo(
    () =>
      (plan: PlanCatalogEntry): ResolvedCta => {
        if (currentPlan && plan.id === currentPlan) {
          return { label: 'Current plan', variant: 'outline', disabled: true };
        }
        if (plan.id === 'enterprise') {
          return {
            label: 'Contact sales',
            variant: 'outline',
            href: `mailto:${SALES_EMAIL}?subject=Enterprise%20plan%20inquiry`,
          };
        }
        if (plan.id === 'free') {
          if (isAuthenticated) {
            return { label: 'Go to dashboard', variant: 'outline', href: '/dashboard' };
          }
          return { label: 'Start free', variant: 'outline', href: '/sign-up' };
        }
        if (!isCheckoutPlan(plan.id)) {
          return { label: plan.cta, variant: 'default', disabled: true };
        }
        if (isDemoBilling) {
          return isAuthenticated
            ? {
                label: 'Continue in demo',
                variant: plan.highlight ? 'default' : 'outline',
                href: '/dashboard/billing',
              }
            : {
                label: 'Start free trial',
                variant: plan.highlight ? 'default' : 'outline',
                href: '/sign-up',
              };
        }
        if (!isAuthenticated) {
          return {
            label: plan.cta,
            variant: plan.highlight ? 'default' : 'outline',
            href: `/sign-up?plan=${plan.id}&next=/checkout/start%3Fplan%3D${plan.id}`,
          };
        }
        const baseline: PlanType = currentPlan ?? 'free';
        const direction = comparePlans(plan.id, baseline);
        const label =
          direction > 0 ? `Upgrade to ${plan.name}` : direction < 0 ? `Switch to ${plan.name}` : plan.cta;
        return {
          label,
          variant: plan.highlight ? 'default' : 'outline',
          onClick: () => handleCheckout(plan.id as CheckoutPlan),
        };
      },
    [currentPlan, isAuthenticated, isDemoBilling, handleCheckout],
  );

  return (
    <div className="flex flex-col gap-16 py-12">
      {/* Header */}
      <div className="text-center px-6">
        <Badge variant="outline" className="mb-4 gap-1.5">
          <Zap className="h-3 w-3" />
          Simple, transparent pricing
        </Badge>
        <h1 className="font-[family-name:var(--font-serif)] text-4xl md:text-5xl text-foreground">
          Choose your plan
        </h1>
        <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
          Start free. No credit card required. Scale as you grow.
        </p>
        {isDemoBilling ? (
          <div className="mx-auto mt-6 max-w-3xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">Stripe checkout is paused during account review.</p>
            <p className="mt-1 text-xs">
              Free trial and demo workspaces remain available. Paid plan checkout will reopen when live
              billing is re-enabled.
            </p>
          </div>
        ) : null}
      </div>

      {/* Plan cards */}
      <div className="px-6">
        {error ? (
          <div className="mx-auto mb-6 max-w-3xl rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {checkoutFallback ? (
          <div className="mx-auto mb-6 max-w-3xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">Checkout is paused</p>
            <p className="mt-1 text-xs">{checkoutFallback.message}</p>
            <div className="mt-3 flex flex-wrap gap-3 text-xs font-medium">
              <a className="underline underline-offset-4" href={checkoutFallback.fallbackHref}>
                {checkoutFallback.fallbackLabel}
              </a>
              <a className="underline underline-offset-4" href={checkoutFallback.salesHref}>
                Contact sales
              </a>
            </div>
          </div>
        ) : null}
        <div className="mx-auto max-w-6xl grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {PLAN_CATALOG.map((plan) => {
            const cta = resolveCta(plan);
            const buttonInner = (
              <>
                {loadingPlan === plan.id ? 'Redirecting…' : cta.label}
                {plan.id !== 'enterprise' && plan.id !== 'free' && !cta.disabled ? (
                  <ArrowRight className="h-4 w-4" />
                ) : null}
              </>
            );
            return (
              <Card
                key={plan.id}
                className={plan.highlight ? 'border-primary shadow-lg shadow-primary/10 relative' : ''}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-primary text-primary-foreground">Most popular</Badge>
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="text-xl">{plan.name}</CardTitle>
                  <CardDescription className="mt-2">{plan.tagline}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-bold">{plan.priceLabel}</span>
                    {plan.interval && plan.monthlyPriceUsd !== null ? (
                      <span className="text-muted-foreground">/{plan.interval}</span>
                    ) : null}
                  </div>
                  <ul className="space-y-2 text-sm">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2 text-muted-foreground">
                        <Check className="mt-0.5 h-3.5 w-3.5 text-primary shrink-0" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter className="flex flex-col gap-3">
                  {cta.href ? (
                    <Button
                      asChild
                      variant={cta.variant}
                      className="w-full gap-2"
                      disabled={cta.disabled}
                    >
                      <a href={cta.href}>{buttonInner}</a>
                    </Button>
                  ) : (
                    <Button
                      variant={cta.variant}
                      className="w-full gap-2"
                      onClick={cta.onClick}
                      disabled={cta.disabled || loadingPlan !== null}
                    >
                      {buttonInner}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Feature comparison table */}
      <div className="px-6">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-2xl font-semibold text-center mb-8">Compare plans</h2>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left p-4 font-medium text-sm text-muted-foreground">Feature</th>
                {PLAN_CATALOG.map((plan) => (
                    <th key={plan.id} className="text-center p-4 font-medium text-sm">
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FEATURE_COMPARISON.map((row, i) => (
                  <tr key={row.feature} className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                    <td className="p-4 text-sm font-medium">{row.feature}</td>
                    <td className="p-4 text-center text-sm"><CheckIcon value={row.free} /></td>
                    <td className="p-4 text-center text-sm"><CheckIcon value={row.starter} /></td>
                    <td className="p-4 text-center text-sm"><CheckIcon value={row.growth} /></td>
                    <td className="p-4 text-center text-sm"><CheckIcon value={row.enterprise} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* FAQ */}
      <div className="px-6">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-semibold text-center mb-8">Frequently asked</h2>
          <div className="space-y-4">
            {[
              {
                q: 'What counts as a voice minute?',
                a: 'Only outbound calls count against your minute limit. Inbound calls are free. A 2-minute call uses 2 minutes.',
              },
              {
                q: 'Can I change plans later?',
                a: 'Yes. Upgrade or downgrade at any time. Upgrades take effect immediately; downgrades at the next billing cycle.',
              },
              {
                q: 'Do unused minutes roll over?',
                a: 'No, minutes reset each billing period. Annual plans include rollover for unused minutes.',
              },
              {
                q: 'What about compliance?',
                a: 'All plans include basic compliance (DNC, DND, consent). Growth and Enterprise include advanced compliance blocks for regulated industries.',
              },
              {
                q: 'Is there a free trial for paid plans?',
                a: 'Starter plans include a 14-day free trial. No credit card required to start.',
              },
            ].map((faq, i) => (
              <div key={i} className="rounded-lg border border-border p-4">
                <h3 className="font-medium text-sm">{faq.q}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="px-6">
        <div className="mx-auto max-w-2xl text-center bg-muted/30 rounded-2xl p-8">
          <h2 className="text-2xl font-semibold">Still have questions?</h2>
          <p className="mt-2 text-muted-foreground">
            Talk to our team. We&apos;ll help you find the right plan.
          </p>
          <Button asChild variant="outline" className="mt-4 gap-2">
            <a href={`mailto:${SALES_EMAIL}?subject=VoiceForge%20pricing%20question`}>
              Contact sales
              <ArrowRight className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
