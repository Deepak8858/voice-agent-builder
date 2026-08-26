import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'Retell AI Alternative for Agencies | VoiceForge',
  'Evaluate VoiceForge for provider-neutral Agent Specs, browser call testing, compliance controls, and branded client workspaces.',
  '/compare/retell-alternative',
);

export default function RetellAlternativePage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Retell AI alternative', path: '/compare/retell-alternative' },
        ])}
      />
      <SeoPage
        eyebrow="Retell AI alternative for agencies"
        title="Keep client voice agents portable and reviewable"
        intro="VoiceForge is an agency control plane that can use Retell as a supported runtime. The deployment itself lives in a validated, versioned Agent Spec instead of one provider configuration."
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
      />
    </>
  );
}
