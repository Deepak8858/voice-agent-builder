import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'Voice AI Integrations and Provider Adapters | VoiceForge',
  'Connect governed voice agents to providers, calendars, data tools, and webhooks without tying the Agent Spec to one runtime.',
  '/integrations',
);

export default function IntegrationsPage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Integrations', path: '/integrations' },
        ])}
      />
      <SeoPage
        eyebrow="Provider-neutral operations"
        title="Voice AI integrations without rebuilding the agent"
        intro="Keep the caller experience in one reviewable Agent Spec. Connect the providers and business systems each client needs through controlled adapters and tools."
        sections={[
          {
            title: 'Choose a voice runtime per deployment',
            body: 'VoiceForge supports Vapi, Retell, OpenAI Realtime, and a LiveKit/Twilio adapter behind one runtime interface. The agent contract stays separate from the provider implementation.',
          },
          {
            title: 'Connect the systems behind the call',
            body: 'Use Google Calendar, Google Sheets, webhooks, and automation platforms such as Zapier, Make, or n8n to move approved information between the agent and business workflows.',
          },
          {
            title: 'Treat every action as a controlled tool',
            body: 'Tool inputs are validated against a schema. VoiceForge checks workspace and agent permission, verifies the integration state, logs execution, and returns a safe result without exposing secrets.',
          },
          {
            title: 'Review before production',
            body: 'Define tools and confirmation requirements in the Agent Spec, run a browser test call, inspect tool activity and outcomes, then publish a known version.',
          },
        ]}
        related={[
          { href: '/how-it-works', label: 'See the governed workflow' },
          { href: '/compare/vapi-alternative', label: 'Evaluate a Vapi alternative' },
          { href: '/compare/retell-alternative', label: 'Evaluate a Retell alternative' },
          { href: '/for-agencies', label: 'VoiceForge for agencies' },
        ]}
      />
    </>
  );
}
