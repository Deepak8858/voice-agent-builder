import Link from 'next/link';
import { BUSINESS_LOCATION, LegalPage, Section, SUPPORT_EMAIL } from '@/components/legal/legal-shell';

export const metadata = {
  title: 'Privacy Policy — VoiceForge AI',
  description:
    'What personal data VoiceForge AI collects, why, who processes it, how long it is kept, and how to exercise your data rights.',
  alternates: { canonical: '/privacypolicy' },
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      lastUpdated="August 19, 2026"
      intro={
        <>
          This policy explains what personal data VoiceForge AI collects, why we collect it, who else
          processes it, how long we keep it, and how to get it deleted. VoiceForge AI is operated as a
          sole proprietorship based in {BUSINESS_LOCATION} and is the data controller for account
          data. For call data that our customers put through the platform, our customer is the
          controller and we act as their processor under our{' '}
          <Link href="/legal/dpa" className="text-primary underline">
            data processing addendum
          </Link>
          .
        </>
      }
    >
      <Section title="Data we collect">
        <p className="font-medium text-foreground">Account and billing data</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Name, email address, and authentication identifiers</li>
          <li>Organization and workspace names, and team membership roles</li>
          <li>Subscription plan, billing status, invoices, and payment history</li>
        </ul>
        <p className="mt-4 font-medium text-foreground">Product usage data</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Agent configurations, prompts, versions, and knowledge base documents you upload</li>
          <li>Minutes consumed, call counts, and quota state</li>
          <li>Audit records of significant actions, such as publishing an agent or changing settings</li>
          <li>Technical logs including IP address, browser type, timestamps, and error traces</li>
        </ul>
        <p className="mt-4 font-medium text-foreground">Call data</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Call audio recordings, where recording is enabled</li>
          <li>Transcripts of what was said</li>
          <li>Caller and called phone numbers</li>
          <li>
            Call metadata: duration, direction, outcome, timestamps, and the tool actions the agent
            took
          </li>
          <li>Contact records that customers import for outbound campaigns</li>
        </ul>
        <p className="mt-4">
          We do not process payment card numbers. Card details are entered directly into Stripe and
          never reach our servers. We do not intentionally collect health records or other special
          category data, and the platform is not intended for that use.
        </p>
      </Section>

      <Section title="Why we process it">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">To provide the service</strong> — running agents,
            placing and receiving calls, producing transcripts and analytics. This is necessary to
            perform our contract with you.
          </li>
          <li>
            <strong className="text-foreground">To bill you</strong> — metering minutes, taking
            subscription payments, and issuing receipts.
          </li>
          <li>
            <strong className="text-foreground">To keep the platform safe and lawful</strong> —
            enforcing do-not-call suppression, quiet hours, consent checks, rate limits, and abuse
            detection. This is our legitimate interest and, in places, a legal obligation.
          </li>
          <li>
            <strong className="text-foreground">To support you</strong> — investigating the problems
            you report to us.
          </li>
          <li>
            <strong className="text-foreground">To operate and improve reliability</strong> — error
            monitoring and aggregate product analytics.
          </li>
        </ul>
        <p className="mt-3">
          We do not sell personal data, and we do not use your call content or agent configuration to
          train our own general-purpose models.
        </p>
      </Section>

      <Section title="Subprocessors">
        <p>We rely on the following providers to deliver the service:</p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Microsoft Azure</strong> — speech recognition, speech
            synthesis, and the language models behind our own voice pipeline
          </li>
          <li>
            <strong className="text-foreground">OpenAI</strong> — the speech-to-speech model used on
            paid plans
          </li>
          <li>
            <strong className="text-foreground">LiveKit</strong> — real-time call media transport
          </li>
          <li>
            <strong className="text-foreground">Twilio</strong> — voice telephony, where you connect it
          </li>
          <li>
            <strong className="text-foreground">Deepgram</strong> — speech-to-text transcription
          </li>
          <li>
            <strong className="text-foreground">Supabase</strong> — database, storage, and
            authentication
          </li>
          <li>
            <strong className="text-foreground">Stripe</strong> — payment processing and subscription
            billing
          </li>
          <li>
            <strong className="text-foreground">Resend</strong> — transactional email
          </li>
        </ul>
        <p className="mt-3">
          Each is bound by its own data protection terms and processes data only to provide its part
          of the service. If you connect additional integrations yourself, data you send through them
          is also governed by those providers&apos; terms.
        </p>
      </Section>

      <Section title="Call recording and consent">
        <p>
          Where recording is enabled, calls are recorded and transcribed so that our customers can
          review and improve their agents. Our customers are responsible for having a lawful basis to
          call each person and to record the conversation, including any requirement to announce the
          recording or to obtain consent. If you received a call from an agent built on VoiceForge and
          want it deleted, contact the business that called you; if you cannot identify them, write to
          us and we will route the request.
        </p>
      </Section>

      <Section title="Retention">
        <p>
          Call records, including recordings and transcripts, are retained for 365 days by default.
          Organizations can configure retention between 30 and 3,650 days in workspace settings. Once
          the retention period passes, records are permanently deleted.
        </p>
        <p className="mt-3">
          Account, billing, and audit records are kept for as long as your account is active and then
          for as long as we are required to retain them for tax and accounting purposes. Backups are
          rotated on a rolling schedule, so deleted data may persist briefly in backups before being
          overwritten.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Data is encrypted in transit using TLS 1.2 or higher and at rest using AES-256. Provider
          credentials you store are encrypted with authenticated encryption before being written to
          the database and are never displayed back to you. Access to production data is limited to
          the personnel who need it, and significant actions are written to an audit log.
        </p>
        <p className="mt-3">
          No system is perfectly secure. If we discover a breach affecting your personal data, we will
          notify affected customers without undue delay.
        </p>
      </Section>

      <Section title="International transfers">
        <p>
          We operate from {BUSINESS_LOCATION} and our subprocessors are located in several countries,
          including the United States and the European Union. Where personal data is transferred
          across borders, we rely on our subprocessors&apos; standard contractual clauses and
          equivalent safeguards.
        </p>
      </Section>

      <Section title="Your rights">
        <p>Depending on where you live, you may have the right to:</p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>Access the personal data we hold about you</li>
          <li>Correct data that is inaccurate</li>
          <li>Request erasure of your personal data</li>
          <li>Receive a portable copy of your data</li>
          <li>Object to or restrict certain processing</li>
          <li>Withdraw consent where processing relies on consent</li>
        </ul>
        <p className="mt-4">
          You can delete your account from your settings, which removes your workspace data subject to
          the retention rules above. To make any other request, email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>
          . We will respond within 30 days. We may ask you to verify your identity before acting on a
          request.
        </p>
      </Section>

      <Section title="Cookies">
        <p>
          We use cookies and equivalent local storage that are necessary to sign you in, keep your
          session, and remember interface preferences. We also use privacy-respecting product
          analytics to understand which features are used. We do not run third-party advertising
          trackers.
        </p>
      </Section>

      <Section title="Children">
        <p>
          The service is intended for business use and is not directed at children. We do not
          knowingly collect personal data from anyone under 18. If you believe a child has provided us
          data, contact us and we will delete it.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          If we make a material change to how we handle personal data, we will update the date at the
          top of this page and notify account owners by email. Continuing to use the service after a
          change takes effect means you accept the updated policy.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Privacy questions and data requests:{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>
        </p>
        <p className="mt-3">
          See also our{' '}
          <Link href="/legal/dpa" className="text-primary underline">
            data processing addendum
          </Link>
          ,{' '}
          <Link href="/services" className="text-primary underline">
            services
          </Link>
          , and{' '}
          <Link href="/refund" className="text-primary underline">
            refund policy
          </Link>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
