import Link from 'next/link';
import { MINUTE_PACK } from '@voiceforge/shared';
import { BUSINESS_LOCATION, LegalPage, Section, SUPPORT_EMAIL } from '@/components/legal/legal-shell';

export const metadata = {
  title: 'Refund & Cancellation Policy — VoiceForge AI',
  description:
    'VoiceForge AI refund policy: 14-day refund on your first subscription payment, how to cancel, and how prepaid minute packs are treated.',
  alternates: { canonical: '/refund' },
};

export default function RefundPolicyPage() {
  return (
    <LegalPage
      title="Refund & Cancellation Policy"
      lastUpdated="August 19, 2026"
      intro={
        <>
          VoiceForge AI is a subscription service billed in US dollars through Stripe. This page
          explains exactly when you are entitled to a refund, how to cancel, and which charges are
          non-refundable. Nothing here limits rights you may have under the consumer law that applies
          to you.
        </>
      }
    >
      <Section title="14-day refund on your first subscription payment">
        <p>
          If VoiceForge is not right for you, email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>{' '}
          within <strong className="text-foreground">14 days</strong> of your first subscription
          charge and we will refund that charge in full. You do not need to justify the request.
        </p>
        <p className="mt-3">
          This guarantee applies once per customer, to the first paid subscription payment on the
          account. Renewal payments after that first period are not covered by the 14-day guarantee —
          cancel before a period ends to avoid being charged for the next one.
        </p>
      </Section>

      <Section title="Cancelling your subscription">
        <p>
          You can cancel at any time from the billing section of your dashboard, which opens the
          Stripe customer portal. Cancellation takes effect at the end of the period you have already
          paid for: you keep full access until then, and you are not charged again.
        </p>
        <p className="mt-3">
          We do not pro-rate or refund the unused remainder of a period that has already started,
          except under the 14-day guarantee above or where required by law. Included minutes are
          allocated per period and do not carry over after cancellation.
        </p>
      </Section>

      <Section title="Prepaid minute packs">
        <p>
          Minute packs are one-time purchases of {MINUTE_PACK.minutes} minutes for $
          {MINUTE_PACK.priceUsd}, valid for {MINUTE_PACK.expiresAfterDays} days from purchase.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Unused packs:</strong> if you have not consumed any
            minutes from a pack, contact us within 14 days of purchase and we will refund it in full.
          </li>
          <li>
            <strong className="text-foreground">Used packs:</strong> once minutes from a pack have
            been consumed, the pack is non-refundable. Telephony and model capacity for those minutes
            has already been delivered and paid out to our providers.
          </li>
          <li>
            <strong className="text-foreground">Expired minutes:</strong> minutes remaining after the{' '}
            {MINUTE_PACK.expiresAfterDays}-day validity window are forfeited and are not refunded or
            reinstated.
          </li>
        </ul>
        <p className="mt-3">
          Because usage is prepaid, there is no automatic overage billing. You will never be invoiced
          for minutes you did not explicitly purchase.
        </p>
      </Section>

      <Section title="Service problems and duplicate charges">
        <p>
          Outside the 14-day window we will still issue a refund or account credit where the fault is
          ours, including:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>Duplicate or accidental charges for the same period</li>
          <li>Being billed after a confirmed cancellation</li>
          <li>Billing for a plan you did not select</li>
          <li>A sustained platform outage that prevented you from using the service you paid for</li>
        </ul>
        <p className="mt-3">
          Tell us what happened and we will investigate. If a defect on our side made the service
          unusable, we would rather refund you than argue about it.
        </p>
      </Section>

      <Section title="What is not refundable">
        <ul className="list-disc space-y-1 pl-5">
          <li>Subscription periods already consumed, beyond the 14-day first-payment guarantee</li>
          <li>Minutes already used, whether included in a plan or bought as a pack</li>
          <li>Charges billed to you directly by your own telephony provider or carrier</li>
          <li>Accounts terminated for abuse, fraud, or unlawful calling</li>
          <li>Enterprise agreements, which are governed by their own signed contract terms</li>
        </ul>
      </Section>

      <Section title="How to request a refund">
        <p>Email us with:</p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>The email address on your VoiceForge account</li>
          <li>The date and amount of the charge, or the Stripe receipt</li>
          <li>A short description of the problem, if there is one</li>
        </ul>
        <p className="mt-4">
          Send it to{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>
          . We aim to reply within one business day and to decide on refund requests within three
          business days.
        </p>
        <p className="mt-3">
          Approved refunds are returned to the original payment method through Stripe. Once we submit
          the refund, your bank or card issuer typically takes 5–10 business days to post it. We
          cannot refund to a different card or account.
        </p>
      </Section>

      <Section title="Chargebacks">
        <p>
          Please contact us before filing a chargeback with your bank. Chargebacks take weeks to
          resolve and cause automatic account suspension while they are open, whereas we can usually
          settle a legitimate refund request in a few days.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          VoiceForge AI is operated as a sole proprietorship based in {BUSINESS_LOCATION}. Billing
          and refund enquiries:{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
        <p className="mt-3">
          See also our <Link href="/services" className="text-primary underline">services</Link> and{' '}
          <Link href="/support" className="text-primary underline">support</Link> pages.
        </p>
      </Section>
    </LegalPage>
  );
}
