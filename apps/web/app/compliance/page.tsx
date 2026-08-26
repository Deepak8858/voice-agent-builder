import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, pageMetadata } from '@/lib/seo';

const faqs = [
  {
    q: 'Can VoiceForge be used for cold sales calls?',
    a: 'Cold sales is blocked by default. VoiceForge is built for inbound calls and allowed, consent-based purposes such as appointment reminders, missed-call callbacks, lead-form callbacks, order confirmations, event confirmations, and requested follow-up.',
  },
  {
    q: 'What happens before an outbound call runs?',
    a: 'The compliance engine checks the call purpose, consent record, DNC/DND status, opt-out state, calling window, AI disclosure, recording notice, and required audit information. The call runs only when the gate passes.',
  },
  {
    q: 'Does software replace legal advice?',
    a: 'No. VoiceForge provides operational controls, not legal advice. Each operator remains responsible for the laws and permissions that apply to the call, location, industry, and data.',
  },
];

export const metadata = pageMetadata(
  'AI Voice Agent Compliance Controls | VoiceForge',
  'See how VoiceForge gates outbound AI calls with purpose, consent, DNC, opt-out, calling-window, disclosure, and audit controls.',
  '/compliance',
);

export default function CompliancePage() {
  const faqData = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
  return (
    <>
      <JsonLd data={faqData} />
      <SeoPage
        eyebrow="Compliance by construction"
        title="AI voice agent compliance starts before the call"
        intro="VoiceForge makes permission to operate an execution rule. An outbound call cannot run unless its purpose and compliance checks pass."
        sections={[
          {
            title: 'A hard outbound gate',
            body: 'Compliance is evaluated before execution, not added as a warning after a campaign is configured.',
            bullets: [
              'Consent records and allowed purpose',
              'DNC, DND, and opt-out suppression',
              'Calling windows, AI disclosure, and recording notice',
              'Audit logs for critical decisions',
            ],
          },
          {
            title: 'Allowed purposes are explicit',
            body: 'Supported outbound purposes include appointment reminders, missed-call callbacks, lead-form callbacks, order and event confirmations, and requested follow-up.',
          },
          {
            title: 'High-risk uses are blocked by default',
            body: 'Cold sales, political calls, debt collection, healthcare diagnosis, and financial or legal advice are not normal VoiceForge workflows.',
          },
          {
            title: 'Questions operators ask',
            body: 'The controls support responsible operations, but they do not replace legal review.',
            bullets: faqs.map((item) => `${item.q} ${item.a}`),
          },
        ]}
        related={[
          { href: '/how-it-works', label: 'See the build-to-publish workflow' },
          { href: '/for-agencies', label: 'VoiceForge for agencies' },
          { href: '/templates', label: 'Explore permitted use cases' },
        ]}
      />
    </>
  );
}
