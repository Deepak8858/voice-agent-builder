import { SeoPage } from '@/components/marketing/seo-page';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'AI Voice Agent Platform for Agencies | VoiceForge',
  'Build, test, govern, and white-label AI voice agents for local-business clients from isolated agency and client workspaces.',
  '/for-agencies',
);

export default function ForAgenciesPage() {
  return (
    <SeoPage
      eyebrow="Built for agencies"
      title="The AI voice agent platform for agencies"
      intro="Sell reliable inbound receptionists, appointment workflows, and missed-call recovery without rebuilding the operating layer for every client."
      sections={[
        {
          title: 'Move from demo to repeatable delivery',
          body: 'VoiceForge turns each client deployment into a reviewable Agent Spec, a tested call path, a published version, and an observable production workflow.',
          bullets: [
            'Generate from a plain-language client brief',
            'Review goals, tools, guardrails, and handoff behavior',
            'Test the complete call before attaching real telephony',
          ],
        },
        {
          title: 'Separate every client',
          body: 'The platform-to-agency-to-client hierarchy keeps agents, knowledge, calls, analytics, users, and settings scoped to the correct workspace.',
          bullets: [
            'Agency owner and member roles',
            'Client admin and viewer access',
            'Client-specific branding and focused dashboards',
          ],
        },
        {
          title: 'Sell outcomes, not raw minutes',
          body: 'Use call outcomes, booking and qualification signals, transfers, tool success, fallback behavior, and cost per successful outcome to operate each account.',
        },
        {
          title: 'Not a cold-calling machine',
          body: 'VoiceForge is designed around inbound calls and consent-based follow-up. Cold sales, political calls, debt collection, and regulated advice are blocked by default.',
        },
      ]}
      related={[
        { href: '/templates', label: 'Browse agent templates' },
        { href: '/compliance', label: 'Review compliance controls' },
        { href: '/pricing', label: 'See pricing' },
      ]}
    />
  );
}
