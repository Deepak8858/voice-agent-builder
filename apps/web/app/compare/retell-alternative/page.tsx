import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, faqJsonLd, pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'Retell AI Alternative for Agencies | VoiceForge',
  'Evaluate VoiceForge for provider-neutral Agent Specs, browser call testing, compliance controls, and branded client workspaces.',
  '/compare/retell-alternative',
);

const faqs = [
  {
    question: 'How is VoiceForge different from Retell AI?',
    answer:
      'Retell is a platform for configuring and running individual voice agents. VoiceForge treats the agent as a versioned, schema-validated Agent Spec that is reviewed and tested before telephony is attached, and wraps it in the agency layer: isolated client workspaces, white-label branding, per-client analytics, and a compliance gate on every outbound call.',
  },
  {
    question: 'Can my clients see their own agents and calls?',
    answer:
      'Yes. Each client gets an isolated workspace scoped to their agents, knowledge, calls, and analytics, under your branding. One client can never see another client\u2019s data.',
  },
  {
    question: 'What happens when a client asks for a change?',
    answer:
      'Changes produce a new version of the Agent Spec. You can inspect the diff, run a browser test call against the new version, and publish deliberately \u2014 the change history stays auditable instead of living in whoever edited the dashboard last.',
  },
  {
    question: 'Does VoiceForge support cold calling?',
    answer:
      'No. Cold sales calling is blocked by default by the compliance engine, along with political calls, debt collection, and regulated advice. Supported purposes include inbound reception, appointment reminders, missed-call callbacks, lead-form callbacks, order confirmations, and requested follow-ups.',
  },
  {
    question: 'What does VoiceForge cost?',
    answer:
      'There is a free tier for building and testing. Paid plans are $99, $299, and $999 per month.',
  },
];

export default function RetellAlternativePage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Retell AI alternative', path: '/compare/retell-alternative' },
        ])}
      />
      <JsonLd data={faqJsonLd(faqs)} />
      <SeoPage
        eyebrow="Retell AI alternative for agencies"
        title="Keep client voice agents portable and reviewable"
        intro="VoiceForge is an agency control plane. The deployment lives in a validated, versioned Agent Spec instead of one provider configuration, so client work stays reviewable, testable, and portable."
        sections={[
          {
            title: 'Separate behavior from the provider',
            body: 'Define goals, call flow, tools, guardrails, compliance policy, analytics, and handoff behavior once. Use the runtime adapter that fits each deployment without rewriting the operating model.',
          },
          {
            title: 'Review and test a known version',
            body: 'Generate the Agent Spec from a client brief, inspect it, run a browser test call, and publish a version that can be paused and audited.',
          },
          {
            title: 'Operate multiple clients safely',
            body: 'VoiceForge scopes agents, knowledge, calls, analytics, users, and settings to agency and client workspaces. Client roles and branding support a cleaner handoff.',
          },
          {
            title: 'Monitor business outcomes',
            body: 'Inspect transcripts, call events, outcomes, transfer behavior, tool success, fallbacks, duration, and cost per successful outcome instead of treating minutes as the only signal.',
          },
          {
            title: 'When VoiceForge is not the fit',
            body: 'Use a direct provider when your team wants to build the surrounding governance and client-delivery system. Use VoiceForge when that operating layer is the repeated agency cost.',
          },
        ]}
        related={[
          { href: '/integrations', label: 'Review provider adapters' },
          { href: '/how-it-works', label: 'See spec-to-publish workflow' },
          { href: '/resources/test-ai-voice-agent', label: 'Read the testing checklist' },
          { href: '/compare/vapi-alternative', label: 'Compare the Vapi path' },
        ]}
        faqs={faqs}
      />
    </>
  );
}
