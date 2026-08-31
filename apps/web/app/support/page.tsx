import Link from 'next/link';
import {
  BUSINESS_LOCATION,
  LegalPage,
  Section,
  SUPPORT_EMAIL,
} from '@/components/legal/legal-shell';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'VoiceForge AI Support | Product and Billing Help',
  'Contact VoiceForge AI support for product, account, billing, privacy, security, and voice-agent deployment questions.',
  '/support',
);

export default function SupportPage() {
  return (
    <LegalPage
      title="Support"
      lastUpdated="August 19, 2026"
      intro={
        <>
          Support is handled over email by the people who build the product. There is no ticket maze
          and no phone tree.
        </>
      }
    >
      <Section title="Contact us">
        <p className="text-base text-foreground">
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>
        </p>
        <p className="mt-3">
          One address for everything: technical problems, billing questions, refund requests,
          account changes, privacy requests, and security reports.
        </p>
      </Section>

      <Section title="Response times">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">General questions:</strong> within one business day
          </li>
          <li>
            <strong className="text-foreground">Billing and refunds:</strong> first reply within one
            business day, decision within three business days
          </li>
          <li>
            <strong className="text-foreground">Service outage or calls failing:</strong> treated as
            urgent and investigated as soon as we see it
          </li>
          <li>
            <strong className="text-foreground">Security reports:</strong> acknowledged within one
            business day
          </li>
        </ul>
        <p className="mt-3">
          Support is provided in English. We operate from {BUSINESS_LOCATION} and work to India
          Standard Time (UTC+5:30), so replies may land outside your own working day.
        </p>
      </Section>

      <Section title="What to include">
        <p>
          The more of this you send, the faster we can fix it — and please never send passwords, API
          keys, or provider credentials by email.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>The email address on your account, and the workspace name</li>
          <li>What you expected to happen, and what happened instead</li>
          <li>The exact steps that reproduce it</li>
          <li>For call problems: the call ID or the agent name, plus the approximate time</li>
          <li>For billing problems: the date and amount of the charge, or the Dodo Payments receipt</li>
          <li>A screenshot of any error message</li>
        </ul>
      </Section>

      <Section title="Things you can do yourself">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">
              Change plan, update your card, download invoices, or cancel:
            </strong>{' '}
            use the billing section of your dashboard, which opens the Dodo Payments customer portal.
          </li>
          <li>
            <strong className="text-foreground">Check what a call did:</strong> open the call in the
            dashboard to see the transcript, recording, and tool activity.
          </li>
          <li>
            <strong className="text-foreground">Test a change safely:</strong> run a browser test
            call against a draft agent version before publishing it.
          </li>
        </ul>
      </Section>

      <Section title="Reporting a security issue">
        <p>
          Email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>{' '}
          with the subject line beginning &ldquo;Security&rdquo; and a description of the issue and
          how to reproduce it. Please do not publicly disclose the issue until we have had a
          reasonable opportunity to fix it, and do not access or modify other customers&apos; data
          while testing.
        </p>
      </Section>

      <Section title="Privacy and data requests">
        <p>
          To export or delete your data, or to ask how we handle it, email us at the address above.
          Details of what we store and for how long are in our{' '}
          <Link href="/privacypolicy" className="text-primary underline">
            privacy policy
          </Link>{' '}
          and{' '}
          <Link href="/legal/dpa" className="text-primary underline">
            data processing addendum
          </Link>
          .
        </p>
      </Section>

      <Section title="Related pages">
        <p>
          <Link href="/services" className="text-primary underline">
            What the service includes
          </Link>
          {' · '}
          <Link href="/refund" className="text-primary underline">
            Refund &amp; cancellation policy
          </Link>
          {' · '}
          <Link href="/pricing" className="text-primary underline">
            Pricing
          </Link>
        </p>
      </Section>
    </LegalPage>
  );
}
