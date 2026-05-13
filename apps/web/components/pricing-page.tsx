'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check, ArrowRight, Zap } from 'lucide-react';

interface PricingPageProps {
  priceIds?: {
    starter: string | null;
    growth: string | null;
    enterprise: string | null;
  };
}

interface Plan {
  id: string;
  name: string;
  price: number | null;
  priceLabel: string;
  description: string;
  highlight?: boolean;
  badge?: string;
  cta: string;
  ctaVariant?: 'default' | 'outline' | 'secondary';
  limits: {
    agents: string;
    minutes: string;
    outboundCalls: string;
    tools: string;
    workspaces: string;
    contacts: string;
    complianceBlocks: boolean;
  };
  features: string[];
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: null,
    priceLabel: '$0',
    description: 'Try VoiceForge with no commitment. Perfect for exploring the platform.',
    cta: 'Get started free',
    ctaVariant: 'outline',
    limits: {
      agents: '1 agent',
      minutes: '10 trial minutes',
      outboundCalls: '5 trial calls',
      tools: '2 tools',
      workspaces: '1 workspace',
      contacts: '50 contacts',
      complianceBlocks: false,
    },
    features: [
      'AI agent generation from description',
      'Vapi + Twilio voice adapters',
      'Basic compliance checks (DNC, DND)',
      'Consent management',
      'Call transcripts & recordings',
      'Email support',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    price: 49,
    priceLabel: '$49',
    description: 'For small teams starting with voice automation.',
    highlight: true,
    cta: 'Start free trial',
    limits: {
      agents: '3 agents',
      minutes: '300 min/mo',
      outboundCalls: '100 calls/mo',
      tools: '5 tools per agent',
      workspaces: '2 workspaces',
      contacts: '500 contacts',
      complianceBlocks: false,
    },
    features: [
      'Everything in Free',
      '300 voice minutes/month',
      '5 agents with full customization',
      'White-label subdomain',
      'API access',
      'Analytics dashboard',
      'Priority email support',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    price: 149,
    priceLabel: '$149',
    description: 'For agencies and growing teams scaling voice operations.',
    cta: 'Get started',
    limits: {
      agents: '10 agents',
      minutes: '2,000 min/mo',
      outboundCalls: '500 calls/mo',
      tools: '20 tools per agent',
      workspaces: '5 workspaces',
      contacts: '5,000 contacts',
      complianceBlocks: true,
    },
    features: [
      'Everything in Starter',
      '2,000 voice minutes/month',
      'Unlimited call campaigns',
      'Full white-label (custom domain)',
      'Bulk CSV contact import',
      'Advanced compliance blocks',
      'Weekly digest emails',
      'Calendar integrations (Google, Cal.com)',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 499,
    priceLabel: '$499',
    description: 'For organizations with advanced needs and scale requirements.',
    cta: 'Contact sales',
    limits: {
      agents: 'Unlimited',
      minutes: 'Unlimited',
      outboundCalls: 'Unlimited',
      tools: 'Unlimited',
      workspaces: 'Unlimited',
      contacts: 'Unlimited',
      complianceBlocks: true,
    },
    features: [
      'Everything in Growth',
      'Unlimited everything',
      'Dedicated account manager',
      'Custom SLA',
      'HIPAA-ready infrastructure',
      'SSO / SAML',
      'Audit logs & compliance exports',
      'Multi-region deployment',
    ],
  },
];

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

export function PricingPage({ priceIds }: PricingPageProps) {
  const router = useRouter();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);

  const handlePlanSelect = async (planId: string) => {
    if (planId === 'free') {
      router.push('/sign-up');
      return;
    }
    if (planId === 'enterprise') {
      router.push('/contact-sales');
      return;
    }

    setLoadingPlan(planId);
    // The checkout flow is handled by the billing page
    // For now, redirect to sign-up with plan context
    router.push(`/sign-up?plan=${planId}`);
  };

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
      </div>

      {/* Plan cards */}
      <div className="px-6">
        <div className="mx-auto max-w-6xl grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {PLANS.map((plan) => (
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
                <CardDescription className="mt-2">{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-bold">{plan.priceLabel}</span>
                  {plan.price !== null && (
                    <span className="text-muted-foreground">/month</span>
                  )}
                </div>
                <div className="space-y-2 text-sm">
                  {Object.entries(plan.limits).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2 text-muted-foreground">
                      <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="capitalize">
                        {typeof value === 'boolean' ? (value ? key.replace(/([A-Z])/g, ' $1').trim() : '') : value}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
              <CardFooter className="flex flex-col gap-3">
                <Button
                  variant={plan.ctaVariant as 'default' | 'outline' | 'secondary' ?? 'default'}
                  className="w-full gap-2"
                  onClick={() => handlePlanSelect(plan.id)}
                  disabled={loadingPlan !== null}
                >
                  {loadingPlan === plan.id ? 'Loading…' : plan.cta}
                  {plan.id !== 'enterprise' && plan.id !== 'free' && (
                    <ArrowRight className="h-4 w-4" />
                  )}
                </Button>
              </CardFooter>
            </Card>
          ))}
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
                  {PLANS.map((plan) => (
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
          <Link href="/contact" className="inline-block mt-4">
            <Button variant="outline" className="gap-2">
              Contact sales
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}