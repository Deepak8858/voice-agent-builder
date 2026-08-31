import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, pageMetadata, techArticleJsonLd } from '@/lib/seo';

export const metadata = pageMetadata(
  'White-Label AI Voice Agents for Agencies',
  'Learn what agencies need to deliver white-label AI voice agents with client isolation, testing, governance, branding, and outcome visibility.',
  '/resources/white-label-ai-voice-agents',
);

export default function WhiteLabelVoiceAgentGuidePage() {
  return (
    <>
      <JsonLd
        data={techArticleJsonLd({
          headline: 'White-Label AI Voice Agents for Agencies',
          description:
            'What agencies need to deliver white-label AI voice agents: client isolation, reviewable deployments, testing evidence, governance, and outcome visibility.',
          path: '/resources/white-label-ai-voice-agents',
          datePublished: '2026-08-24',
          dateModified: '2026-08-31',
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
          { name: 'White-label AI voice agents', path: '/resources/white-label-ai-voice-agents' },
        ])}
      />
      <SeoPage
        eyebrow="White-label AI voice agents"
        title="A logo is not an agency operating layer"
        intro="A client-ready voice-agent service needs isolation, a reviewable deployment, safe access, testing evidence, and outcome visibility. Branding is the final layer, not the foundation."
        sections={[
          {
            title: 'Separate every client',
            body: 'Scope agents, knowledge, calls, analytics, users, integrations, and settings to the correct workspace. Define client admin and viewer roles so access matches responsibility.',
          },
          {
            title: 'Make the deployment reviewable',
            body: 'Keep goals, call flow, tools, guardrails, compliance policy, analytics, and handoff behavior in one versioned contract. The agency and client should know what will change before publishing.',
          },
          {
            title: 'Prove the caller journey',
            body: 'Run the full call path before production. Review transcript, events, tool activity, fallbacks, transfers, and outcome. Do not hand a client a polished dashboard around an untested prompt.',
          },
          {
            title: 'Show the metrics that guide action',
            body: 'Report outcomes, bookings, qualification signals, transfers, tool success, fallback behavior, duration, and cost per successful outcome. Raw minutes alone do not explain whether the deployment worked.',
          },
          {
            title: 'Keep compliance in the workflow',
            body: 'Inbound and consent-based follow-up should be the default motion. For outbound execution, verify the permitted purpose, consent, DNC/DND status, opt-out state, calling window, disclosures, and audit information.',
          },
          {
            title: 'Apply the client brand last',
            body: 'Add the agency or client logo, colors, and focused client-facing pages after the operating boundaries are correct. White-label delivery should simplify trust, not hide how the system is governed.',
          },
        ]}
        related={[
          { href: '/for-agencies', label: 'Explore VoiceForge for agencies' },
          { href: '/resources/test-ai-voice-agent', label: 'Use the testing checklist' },
          { href: '/compare/vapi-alternative', label: 'Evaluate the Vapi path' },
          { href: '/pricing', label: 'See VoiceForge pricing' },
        ]}
      />
    </>
  );
}
