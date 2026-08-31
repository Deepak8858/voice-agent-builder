import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, pageMetadata, techArticleJsonLd } from '@/lib/seo';

export const metadata = pageMetadata(
  'How to Test an AI Voice Agent Before Launch',
  'Use this AI voice agent QA checklist to test call paths, tools, transfers, fallbacks, compliance, and outcomes before production.',
  '/resources/test-ai-voice-agent',
);

export default function TestVoiceAgentGuidePage() {
  return (
    <>
      <JsonLd
        data={techArticleJsonLd({
          headline: 'How to Test an AI Voice Agent Before Launch',
          description:
            'A QA checklist for AI voice agents: call paths, tools, transfers, fallbacks, compliance, and outcomes — tested before production telephony is attached.',
          path: '/resources/test-ai-voice-agent',
          datePublished: '2026-08-24',
          dateModified: '2026-08-31',
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
          { name: 'Test an AI voice agent', path: '/resources/test-ai-voice-agent' },
        ])}
      />
      <SeoPage
        eyebrow="AI voice agent QA checklist"
        title="Test the call path, not just the prompt"
        intro="A convincing demo is not production evidence. Test the complete caller journey, the systems behind it, and the behavior when the happy path breaks."
        sections={[
          {
            title: '1. Define a pass condition',
            body: 'Write the caller goal and the observable outcome before making the test call. Examples include an appointment recorded, a message captured with required fields, or a completed transfer.',
          },
          {
            title: '2. Exercise the happy path',
            body: 'Test greetings, intent recognition, knowledge retrieval, required questions, tool inputs, confirmations, and the final outcome. Inspect the transcript and event stream rather than relying on how the call sounded.',
          },
          {
            title: '3. Break the expected sequence',
            body: 'Interrupt the agent, change the request, provide incomplete information, repeat an answer, stay silent, and ask an unrelated question. Confirm that the call recovers without inventing information or skipping required steps.',
          },
          {
            title: '4. Test tools and transfers',
            body: 'Use valid, invalid, duplicate, and missing inputs. Confirm that permission checks and required confirmations run. Verify the caller receives a safe fallback when a calendar, CRM, webhook, or transfer fails.',
          },
          {
            title: '5. Test compliance behavior',
            body: 'For permitted outbound follow-up, verify purpose, consent, DNC/DND status, opt-out handling, calling windows, AI disclosure, recording notice, and the audit trail. A failed gate should stop execution.',
          },
          {
            title: '6. Publish the version you tested',
            body: 'Keep goals, tools, guardrails, compliance policy, analytics, and handoff behavior in a reviewable version. If production evidence reveals a failure, update the contract, repeat the call path, and compare outcomes before republishing.',
          },
        ]}
        related={[
          { href: '/how-it-works', label: 'See VoiceForge testing workflow' },
          { href: '/compliance', label: 'Review compliance gates' },
          { href: '/templates', label: 'Start from a tested structure' },
          { href: '/resources/white-label-ai-voice-agents', label: 'Plan the client handoff' },
        ]}
      />
    </>
  );
}
