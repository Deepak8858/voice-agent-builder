import Link from 'next/link';
import { MINUTE_PACK, PLAN_CATALOG } from '@voiceforge/shared';
import { BUSINESS_LOCATION, LegalPage, Section, SUPPORT_EMAIL } from '@/components/legal/legal-shell';

export const metadata = {
  title: 'Services — VoiceForge AI',
  description:
    'What VoiceForge AI sells: hosted AI voice calling agents, the plans available, how billing works, and what is excluded.',
  alternates: { canonical: '/services' },
};

export default function ServicesPage() {
  return (
    <LegalPage
      title="Services"
      lastUpdated="August 19, 2026"
      intro={
        <>
          VoiceForge AI is a software-as-a-service platform for building, testing, deploying, and
          monitoring AI voice calling agents. Service is sold online as a monthly subscription and is
          delivered entirely over the internet. There is no physical product and nothing is shipped.
        </>
      }
    >
      <Section title="What the service does">
        <p>
          You describe the agent you want in natural language. VoiceForge generates a structured
          Agent Spec, which you can review, edit, version, and test in the browser. Once published,
          the agent can answer inbound calls and place outbound calls over the public telephone
          network, using a telephony provider you connect.
        </p>
        <p className="mt-3">Included capabilities:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Natural-language agent generation with a reviewable Agent Spec</li>
          <li>Agent versioning, publishing, and rollback</li>
          <li>Browser-based test calls before going live</li>
          <li>Inbound and outbound calling with call recordings and transcripts</li>
          <li>Knowledge base retrieval so agents can answer from your documents</li>
          <li>Outbound campaigns with contact lists</li>
          <li>Call analytics and per-workspace usage reporting</li>
          <li>Compliance controls: do-not-call suppression, quiet hours, and consent checks</li>
          <li>Third-party tool integrations for looking up and writing data during a call</li>
          <li>White-label branding and client workspaces on higher tiers</li>
        </ul>
      </Section>

      <Section title="Plans and pricing">
        <p>
          All prices are in US dollars and billed monthly per organization. Current plans:
        </p>
        <div className="mt-4 space-y-4">
          {PLAN_CATALOG.map((plan) => (
            <div key={plan.id} className="rounded-lg border bg-background p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-base font-semibold text-foreground">{plan.name}</span>
                <span className="font-[family-name:var(--font-mono)] text-sm text-foreground">
                  {plan.priceLabel}
                  {plan.id === 'enterprise' ? '' : ' / month'}
                </span>
              </div>
              <p className="mt-1">{plan.tagline}</p>
              <ul className="mt-3 grid gap-1 sm:grid-cols-2">
                <li>{plan.marketingLimits.minutes}</li>
                <li>{plan.marketingLimits.agents}</li>
                <li>{plan.marketingLimits.concurrentCalls}</li>
                <li>{plan.marketingLimits.tools}</li>
                <li>{plan.marketingLimits.workspaces}</li>
                <li>{plan.marketingLimits.contacts}</li>
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-4">
          The Free plan does not include telephone calling. It provides a monthly allowance of
          browser-based test minutes, which reset each month, so you can evaluate the product before
          paying. Starter and Growth are purchased directly on the site. Enterprise is
          sales-assisted and contracted separately.
        </p>
        <p className="mt-3">
          See <Link href="/pricing" className="text-primary underline">the pricing page</Link> for
          the current published rates, which are authoritative.
        </p>
      </Section>

      <Section title="How usage is metered">
        <p>
          Calling is metered in minutes of connected call time. Each paid plan includes a monthly
          minute allowance that resets at the start of every billing period. Unused included minutes
          do not roll over.
        </p>
        <p className="mt-3">
          If you need more minutes than your plan includes, you can buy a prepaid pack of{' '}
          {MINUTE_PACK.minutes} minutes for ${MINUTE_PACK.priceUsd}. Purchased minutes are consumed
          only after your included minutes are used up, and expire{' '}
          {MINUTE_PACK.expiresAfterDays} days after purchase.
        </p>
        <p className="mt-3">
          There is no automatic overage billing. When you run out of available minutes, further paid
          calls are refused until the next period begins or you buy a pack. You will never receive a
          surprise invoice for usage above your plan.
        </p>
      </Section>

      <Section title="Service delivery and activation">
        <p>
          Access is activated immediately after a successful payment — typically within seconds of
          checkout completing. There is no waiting period, onboarding fee, or manual provisioning
          step for self-service plans. Because the service is delivered instantly and consumed as
          metered usage, please read the{' '}
          <Link href="/refund" className="text-primary underline">refund policy</Link> before
          purchasing.
        </p>
      </Section>

      <Section title="What you need to provide">
        <p>
          VoiceForge is the software layer. To place or receive real telephone calls you must
          connect your own telephony account (for example Twilio or Vobiz) and supply a phone
          number. Carrier charges for that account are billed to you by that carrier directly and
          are not included in your VoiceForge subscription.
        </p>
      </Section>

      <Section title="What is not included">
        <ul className="list-disc space-y-1 pl-5">
          <li>Telephone numbers and carrier minutes from your telephony provider</li>
          <li>Bespoke software development or custom integrations, unless separately contracted</li>
          <li>Legal advice on telemarketing or call-recording law in your jurisdiction</li>
          <li>Any guarantee of business outcomes, such as leads, bookings, or revenue</li>
        </ul>
      </Section>

      <Section title="Acceptable use">
        <p>
          You are responsible for the calls your agents place. You must have a lawful basis to
          contact each person you call, honour do-not-call requests, respect local calling hours,
          and comply with call-recording consent law in every jurisdiction you operate in.
          VoiceForge enforces do-not-call suppression, quiet hours, and consent checks on every plan,
          but these controls assist your compliance programme rather than replace it.
        </p>
        <p className="mt-3">
          Using the platform for fraud, impersonation, harassment, or unlawful robocalling is
          prohibited and will result in suspension.
        </p>
      </Section>

      <Section title="Provider of the service">
        <p>
          VoiceForge AI is operated as a sole proprietorship based in {BUSINESS_LOCATION}, trading
          online at <span className="font-[family-name:var(--font-mono)]">incfrog.ai</span>.
        </p>
        <p className="mt-3">
          Questions about scope, plans, or suitability:{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>
        </p>
      </Section>
    </LegalPage>
  );
}
