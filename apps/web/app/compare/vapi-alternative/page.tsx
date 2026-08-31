import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, faqJsonLd, pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'Vapi Alternative for Voice AI Agencies | VoiceForge',
  'Evaluate VoiceForge when you need white-label client workspaces, provider-neutral Agent Specs, testing, and compliance gates around voice deployments.',
  '/compare/vapi-alternative',
);

const faqs = [
  {
    question: 'Is VoiceForge a replacement for Vapi?',
    answer:
      'For agencies, usually yes. Vapi is a developer voice API: you code and operate the control plane yourself. VoiceForge is the operating layer above the runtime: agents are versioned Agent Spec JSON contracts, every client gets an isolated white-label workspace, and outbound calls pass a compliance gate before they dial. If you want to write and run your own control plane, a direct API remains the better fit.',
  },
  {
    question: 'Can I test an agent before it takes real calls?',
    answer:
      'Yes. Every agent can be exercised in a browser test call with a live transcript, event stream, outcome, and tool activity — before any phone number is attached. Publishing is a deliberate, reviewable step.',
  },
  {
    question: 'How does VoiceForge handle compliance?',
    answer:
      'A compliance engine sits in the execution path: outbound calls require a permitted purpose and a passing check across consent, DNC/DND status, opt-out state, calling windows, AI disclosure, recording notice, and audit requirements. Cold sales calling is blocked by default. These are operational controls, not legal advice — operators remain responsible for applicable law.',
  },
  {
    question: 'What voice runtimes does VoiceForge run on?',
    answer:
      'OpenAI Realtime on paid plans, plus an in-house pipeline built on Azure Speech and Azure OpenAI. Agents are defined as provider-neutral specs, so a deployment can move between runtimes without rebuilding the agent.',
  },
  {
    question: 'What does VoiceForge cost?',
    answer:
      'There is a free tier for building and testing. Paid plans are $99, $299, and $999 per month. Customers are businesses and agencies, not consumers.',
  },
];

export default function VapiAlternativePage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Vapi alternative', path: '/compare/vapi-alternative' },
        ])}
      />
      <JsonLd data={faqJsonLd(faqs)} />
      <SeoPage
        eyebrow="Vapi alternative for agencies"
        title="Choose the operating layer, not just the voice runtime"
        intro="VoiceForge is for agencies that need to create, test, govern, and hand off repeatable client deployments. Vapi is a developer voice API; VoiceForge is the governed operating layer above the runtime."
        sections={[
          {
            title: 'A reviewable contract instead of scattered code',
            body: 'The VoiceForge Agent Spec carries goals, call flow, tools, guardrails, compliance policy, analytics, and handoff behavior. The provider adapter translates that reviewed contract for the runtime.',
          },
          {
            title: 'Test the call before attaching telephony',
            body: 'Run a complete browser test with a live transcript, event stream, outcome, and tool activity. Publish only after reviewing the version you intend to operate.',
          },
          {
            title: 'Deliver a workspace to each client',
            body: 'Separate agency and client workspaces keep agents, knowledge, calls, analytics, users, and settings scoped correctly. Apply client-facing logo and color branding without forking the platform.',
          },
          {
            title: 'Put compliance in the execution path',
            body: 'Outbound calls require a permitted purpose and a passing compliance gate. Cold sales, political calls, debt collection, and regulated advice are blocked by default.',
          },
          {
            title: 'When VoiceForge is not the fit',
            body: 'Choose a direct voice API when you want to code and operate the entire control plane yourself. Choose VoiceForge when governed, multi-client delivery is the work you do not want to rebuild.',
          },
        ]}
        related={[
          { href: '/integrations', label: 'Review provider adapters' },
          { href: '/for-agencies', label: 'Explore agency operations' },
          { href: '/resources/white-label-ai-voice-agents', label: 'White-label delivery guide' },
          { href: '/compare/retell-alternative', label: 'Compare the Retell path' },
        ]}
        faqs={faqs}
      />
    </>
  );
}
