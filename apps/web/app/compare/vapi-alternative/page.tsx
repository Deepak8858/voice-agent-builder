import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'Vapi Alternative for Voice AI Agencies | VoiceForge',
  'Evaluate VoiceForge when you need white-label client workspaces, provider-neutral Agent Specs, testing, and compliance gates around voice deployments.',
  '/compare/vapi-alternative',
);

export default function VapiAlternativePage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Vapi alternative', path: '/compare/vapi-alternative' },
        ])}
      />
      <SeoPage
        eyebrow="Vapi alternative for agencies"
        title="Choose the operating layer, not just the voice runtime"
        intro="VoiceForge is for agencies that need to create, test, govern, and hand off repeatable client deployments. Vapi remains available as one supported runtime adapter."
        sections={[
          {
            title: 'Use Vapi without making it the agent contract',
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
      />
    </>
  );
}
