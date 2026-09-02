import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, faqJsonLd, pageMetadata, techArticleJsonLd } from '@/lib/seo';

export const metadata = pageMetadata(
  'Do You Need Consent to Make AI Phone Calls?',
  'A practical breakdown of consent, DNC, disclosure, and calling windows for AI voice agents — and how to make the checks run before the call, not after.',
  '/resources/ai-call-consent',
);

const faqs = [
  {
    question: 'Do AI phone calls require consent?',
    answer:
      'For most outbound commercial calls, yes — some form of prior consent or an existing business relationship is required, and automated or prerecorded-voice calls typically face stricter consent standards than human calls. The practical answer is that consent is a per-purpose, per-number record you must be able to produce, not a checkbox you set once. This is operational guidance, not legal advice; rules vary by jurisdiction and change.',
  },
  {
    question: 'Does an AI agent have to disclose that it is an AI?',
    answer:
      'In a growing number of jurisdictions, yes — and even where it is not yet mandatory, disclosure is where regulation is clearly heading. Building disclosure into the first sentence of the call costs almost nothing and removes a whole class of future risk. VoiceForge treats AI disclosure as a compliance-policy field on the agent, not a line buried in a prompt.',
  },
  {
    question: 'What is the difference between DNC and opt-out?',
    answer:
      'The Do-Not-Call registry is a list you check before dialing; opt-out is a state your own system must track after someone says stop. Passing a DNC check does not help you if your platform has no record that this specific person asked your specific client not to call them last month. Both checks have to run on every call.',
  },
  {
    question: 'Can inbound AI receptionists skip all of this?',
    answer:
      'Inbound is much simpler — the caller initiated the contact — but not empty. Recording notice still applies in two-party-consent regions, and AI disclosure is still good practice. The heavy machinery (consent records, DNC, calling windows) is an outbound problem.',
  },
  {
    question: 'How does VoiceForge enforce this?',
    answer:
      'A compliance engine sits in the execution path. Every outbound call is checked for permitted purpose, consent record, DNC/DND status, opt-out state, calling window, AI disclosure, recording notice, and audit requirements — and the call does not dial unless the engine returns passed. Cold sales calling is blocked by default. These are operational controls; operators remain responsible for applicable law.',
  },
];

export default function AiCallConsentGuidePage() {
  return (
    <>
      <JsonLd
        data={techArticleJsonLd({
          headline: 'Do You Need Consent to Make AI Phone Calls?',
          description:
            'Consent, DNC, opt-out, disclosure, and calling windows for AI voice agents, treated as pre-call checks instead of post-incident paperwork.',
          path: '/resources/ai-call-consent',
          datePublished: '2026-09-01',
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
          { name: 'AI call consent', path: '/resources/ai-call-consent' },
        ])}
      />
      <JsonLd data={faqJsonLd(faqs)} />
      <SeoPage
        eyebrow="Compliance for AI calling"
        title="Consent is a pre-call check, not post-incident paperwork"
        intro="Most teams treat consent as a legal question to answer later. It is an engineering question to answer before the first call: can your system prove, per number and per purpose, that this call is allowed to happen? This guide covers the operational checks — it is not legal advice, and rules vary by jurisdiction."
        sections={[
          {
            title: 'The five checks every outbound AI call needs',
            body: 'Before an AI agent dials, five questions need machine-checkable answers. Is the purpose permitted — appointment reminder, requested callback, order confirmation — or is it cold solicitation? Is there a consent record or existing relationship for this number and this purpose? Is the number on a do-not-call registry, or has this person opted out with your client specifically? Is it a lawful calling hour in the recipient\u2019s timezone? And will the call disclose recording and AI participation where required? Teams that answer these in a document have paperwork. Teams that answer them in the execution path have compliance.',
          },
          {
            title: 'Consent is per-purpose, not per-company',
            body: 'The most common operational mistake: treating consent as one bit. A patient who consented to appointment reminders did not consent to a win-back campaign. A lead who filled a form asking about pricing did not consent to weekly follow-ups forever. Store consent as a record — number, purpose, source, timestamp — and check the record against the specific call being attempted. When a regulator or an angry customer asks, the answer must be a lookup, not an argument.',
          },
          {
            title: 'Opt-out is your problem, not the registry\u2019s',
            body: 'DNC registries are the public layer. The private layer is your own suppression list: every person who told any of your agents to stop calling. That state has to persist across agent versions, across campaigns, and across the client\u2019s staff changes. If your voice platform cannot answer \u201chas this number ever opted out with this client\u201d in one query, the platform is the risk.',
          },
          {
            title: 'Disclosure costs one sentence',
            body: 'An agent that opens with its name, the business it calls for, and the fact that it is an AI assistant loses almost no conversions and removes an entire class of complaint. Jurisdictions are moving toward mandatory AI disclosure at different speeds, and building it in now means never retrofitting it under deadline. In VoiceForge the disclosure requirement is a field in the agent\u2019s compliance policy, versioned with the spec — not a phrase someone remembers to keep in a prompt.',
          },
          {
            title: 'Why cold calling is blocked by default in VoiceForge',
            body: 'Cold sales calls carry the worst consent posture, the highest complaint rates, and the strictest rules. Supporting them by default would mean every configuration mistake becomes a violation machine. So the compliance engine blocks cold solicitation, political calls, debt collection, and regulated advice out of the box, and every outbound call must return passed across purpose, consent, DNC/DND, opt-out, calling window, disclosure, recording notice, and audit checks before it dials. Agencies deploying reminder, callback, and reception agents never notice the gate. That is the point.',
          },
          {
            title: 'Who this guide is not for',
            body: 'If your business model is high-volume cold outreach, VoiceForge is the wrong tool and this guide will not help you make it compliant — the product blocks that use by design. If you run inbound reception and opt-in follow-up for real local businesses, the checks above are cheap, mechanical, and mostly automatable. That is the deployment model this platform exists for.',
          },
        ]}
        related={[
          { href: '/compliance', label: 'How the compliance gate works' },
          { href: '/resources/test-ai-voice-agent', label: 'Test the call before launch' },
          { href: '/templates/appointment-reminder', label: 'Appointment reminder template' },
          { href: '/for-agencies', label: 'Deploying for clients' },
        ]}
        faqs={faqs}
      />
    </>
  );
}
