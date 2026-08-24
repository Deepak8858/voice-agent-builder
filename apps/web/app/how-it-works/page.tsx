import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'How VoiceForge Builds and Tests Voice Agents',
  'Go from a business brief to Agent Spec JSON, a browser test call, a published version, and monitored voice-agent outcomes.',
  '/how-it-works',
);

export default function HowItWorksPage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'How it works', path: '/how-it-works' },
        ])}
      />
      <SeoPage
        eyebrow="Spec → test → publish"
        title="Build a voice agent like production software"
        intro="VoiceForge replaces the raw-prompt path with a governed workflow. Describe the experience, review the contract, test the call, then publish and improve a known version."
        sections={[
          {
            title: '1. Describe the caller experience',
            body: 'Capture the business, caller intents, transfer rules, knowledge sources, allowed tools, and systems the agent may touch.',
          },
          {
            title: '2. Review Agent Spec JSON',
            body: 'VoiceForge generates a validated, provider-neutral contract containing goals, call flow, tools, guardrails, compliance policy, analytics, and handoff behavior.',
          },
          {
            title: '3. Test the full call path',
            body: 'Run a browser call before connecting live telephony. Inspect the live transcript, event stream, outcome, fallbacks, and tool activity.',
          },
          {
            title: '4. Publish a version',
            body: 'Publish a known spec, pause it when needed, share a demo page, and keep critical actions in the audit trail.',
          },
          {
            title: '5. Monitor and improve',
            body: 'Use transcripts, events, outcomes, usage, and post-call evaluation to identify the next change. Keep improvements tied to reviewable versions.',
          },
        ]}
        related={[
          { href: '/templates', label: 'Start from a template' },
          { href: '/compliance', label: 'Understand compliance gates' },
          { href: '/resources/test-ai-voice-agent', label: 'Use the voice-agent QA checklist' },
          { href: '/integrations', label: 'Review provider and tool integrations' },
          { href: '/for-agencies', label: 'Deliver to agency clients' },
        ]}
      />
    </>
  );
}
