'use client';

import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  BILLING_DISCLOSURES,
  FEATURE_COMPARISON,
  PRICING_FAQ,
} from '@/lib/billing-copy';
import {
  isCheckoutUnavailable,
  type CheckoutUnavailable,
} from '@/lib/checkout-availability';
import { estimatePlan, formatEstimateReason, type PricingEstimateInput } from '@/lib/pricing-estimator';
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
      (u.hostname === 'checkout.dodopayments.com' || u.hostname.endsWith('.dodopayments.com'))
    );
  } catch {
    return false;
  }
}

function CheckIcon({ value }: { value: boolean | string }) {
  if (value === true) return <Check className="h-4 w-4 text-primary mx-auto" />;
  if (value === false) return <span className="text-muted-foreground text-xs">—</span>;
  return <span className="text-xs text-muted-foreground">{value}</span>;
}

async function startCheckout(
  plan: CheckoutPlan,
  idempotencyKey: string,
): Promise<string | CheckoutUnavailable> {
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan, idempotencyKey }),
    credentials: 'include',
  });
  const data = (await res.json().catch(() => null)) as
    | { url?: string; error?: string }
    | CheckoutUnavailable
    | null;
  if (isCheckoutUnavailable(data)) {
    return data;
  }
  if (!res.ok || !data?.url) {
    throw new Error(data?.error ?? `Checkout failed with status ${res.status}.`);
  }
  if (!trustedCheckoutUrl(data.url)) {
    throw new Error('Untrusted checkout URL returned from server.');
  }
  return data.url;
}

export function PricingPage({
  isAuthenticated = false,
  currentPlan = null,
}: PricingPageProps) {
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<CheckoutUnavailable | null>(null);
  const [estimateInput, setEstimateInput] = useState<PricingEstimateInput>({
    agents: 2,
    minutes: 250,
    concurrentCalls: 2,
    tools: 3,
    workspaces: 1,
    contacts: 400,
  });
  const estimate = useMemo(() => estimatePlan(estimateInput), [estimateInput]);

  function updateEstimate(key: keyof PricingEstimateInput, value: string) {
    setEstimateInput((current) => ({
      ...current,
      [key]: Number(value),
    }));
  }

  const handleCheckout = useCallback(async (plan: CheckoutPlan) => {
    setLoadingPlan(plan);
    setError(null);
    setUnavailable(null);
    try {
      const result = await startCheckout(plan, crypto.randomUUID());
      if (typeof result === 'string') {
        window.location.assign(result);
        return;
      }
      setUnavailable(result);
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
          return { label: plan.cta, variant: 'outline', href: '/sign-up' };
        }
        if (!isCheckoutPlan(plan.id)) {
          return { label: plan.cta, variant: 'default', disabled: true };
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
    [currentPlan, isAuthenticated, handleCheckout],
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
          Test in your browser on Free every month, then pick the plan that matches the minutes you
          actually run.
        </p>
      </div>

      {/* Plan cards */}
      <div className="px-6">
        {error ? (
          <div className="mx-auto mb-6 max-w-3xl rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {unavailable ? (
          <div className="mx-auto mb-6 max-w-3xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">{unavailable.title}</p>
            <p className="mt-1 text-xs">{unavailable.message}</p>
            <div className="mt-3 flex flex-wrap gap-3 text-xs font-medium">
              <a className="underline underline-offset-4" href={unavailable.salesHref}>
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
                    {plan.interval && plan.id !== 'enterprise' ? (
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

      <div className="px-6">
        <div className="mx-auto max-w-6xl">
          <Card>
            <CardHeader>
              <CardTitle>Plan estimator</CardTitle>
              <CardDescription>
                Estimate a plan from expected usage. The calculation uses the same limits enforced by billing.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-[1fr_280px]">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {([
                  ['agents', 'Agents'],
                  ['minutes', 'Voice minutes'],
                  ['concurrentCalls', 'Concurrent calls'],
                  ['tools', 'Integration tools'],
                  ['workspaces', 'Workspaces'],
                  ['contacts', 'Contacts'],
                ] as const).map(([key, label]) => (
                  <div key={key}>
                    <Label htmlFor={`estimate-${key}`}>{label}</Label>
                    <Input
                      id={`estimate-${key}`}
                      className="mt-1.5"
                      type="number"
                      min={0}
                      value={estimateInput[key]}
                      onChange={(event) => updateEstimate(key, event.target.value)}
                    />
                  </div>
                ))}
              </div>
              <div className="rounded-md border bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Recommended plan
                </p>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold">{estimate.planName}</span>
                  <span className="text-sm text-muted-foreground">
                    {estimate.monthlyPriceUsd === null ? 'Custom' : `${estimate.priceLabel}/month`}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{formatEstimateReason(estimate)}</p>
                {estimate.exceeded.length > 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Enterprise is recommended because these limits need custom capacity: {estimate.exceeded.join(', ')}.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
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

      {/* How billing works */}
      <div className="px-6">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-2xl font-semibold text-center mb-8">How billing works</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {BILLING_DISCLOSURES.map((disclosure) => (
              <li
                key={disclosure}
                className="flex items-start gap-2 rounded-lg border border-border p-4 text-sm text-muted-foreground"
              >
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>{disclosure}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* FAQ */}
      <div className="px-6">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-semibold text-center mb-8">Frequently asked</h2>
          <div className="space-y-4">
            {PRICING_FAQ.map((faq) => (
              <div key={faq.q} className="rounded-lg border border-border p-4">
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
