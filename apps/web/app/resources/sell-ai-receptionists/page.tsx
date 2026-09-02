import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, faqJsonLd, pageMetadata, techArticleJsonLd } from '@/lib/seo';

export const metadata = pageMetadata(
  'How to Sell AI Receptionists to Local Businesses',
  'A practical playbook for agencies: which businesses actually buy, what to charge, the missed-call pitch that lands, and what to build versus buy.',
  '/resources/sell-ai-receptionists',
);

const faqs = [
  {
    question: 'Which local businesses actually buy AI receptionists?',
    answer:
      'The ones where a missed call is a lost job with a known value: dental and medical practices, home services (plumbing, HVAC, electrical, roofing), law firms, salons and spas, veterinary clinics, and real estate teams. The common trait is not industry but arithmetic — the owner can tell you what one booked appointment is worth, so the value of answering the phone is a calculation rather than an argument.',
  },
  {
    question: 'What should an agency charge for an AI receptionist?',
    answer:
      'Price against the value of a recovered booking, not against your platform cost. If one job is worth a few hundred dollars and the agent recovers several missed calls a month, a monthly retainer in the low hundreds is straightforward to justify. Charging per minute invites the client to audit your margin; charging a flat monthly fee per location keeps the conversation on outcomes.',
  },
  {
    question: 'Should an agency build its own voice platform or buy one?',
    answer:
      'Building one agent is a weekend. Operating twenty for twenty clients is a platform: isolated workspaces, versioned changes, per-client analytics, compliance checks, branding, and a support surface. The second client is where the rebuild tax appears. Most agencies should buy the operating layer and sell the thing they are actually good at, which is knowing the client’s business.',
  },
  {
    question: 'What is the strongest opening pitch?',
    answer:
      'Not the technology. Call the prospect’s own main line after hours and listen to what a customer hears. Then ask what happens to those calls. The pitch writes itself when the owner realises the answer is nothing, and that the phone is already the leakiest part of their funnel.',
  },
  {
    question: 'Is cold calling businesses with an AI agent allowed?',
    answer:
      'Not with VoiceForge — cold sales calling is blocked by default by the compliance engine, along with political calls, debt collection, and regulated advice. Sell inbound reception and opt-in follow-up. Prospecting for your own agency should be done by you, through channels that permit it.',
  },
];

export default function SellAiReceptionistsPage() {
  return (
    <>
      <JsonLd
        data={techArticleJsonLd({
          headline: 'How to Sell AI Receptionists to Local Businesses',
          description:
            'An agency playbook for selling AI receptionists: qualifying by missed-call arithmetic, pricing on outcomes, the discovery call, and build versus buy.',
          path: '/resources/sell-ai-receptionists',
          datePublished: '2026-09-01',
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
          { name: 'Sell AI receptionists', path: '/resources/sell-ai-receptionists' },
        ])}
      />
      <JsonLd data={faqJsonLd(faqs)} />
      <SeoPage
        eyebrow="Agency playbook"
        title="Sell the recovered booking, not the voice agent"
        intro="Local business owners do not buy AI. They buy the appointment that would otherwise have gone to whoever answered the phone. This is the practical version: who qualifies, how to open, what to charge, and the point where running client agents becomes a platform problem you should not solve yourself."
        sections={[
          {
            title: 'Qualify on arithmetic, not on industry',
            body: 'The best prospects can answer one question immediately: what is one new customer worth to you? A dental practice knows a new patient is worth four figures over a year. A plumber knows an emergency call-out is worth a few hundred. A roofer knows a signed job is worth thousands. When the owner has that number, you are not selling technology — you are dividing their missed-call volume by it. Businesses that cannot answer the question are usually not ready, whatever their industry.',
          },
          {
            title: 'Open with their own phone line',
            body: 'The strongest discovery move costs nothing: call the prospect’s main number outside business hours, and again during their busiest hour. Note what happens — voicemail, endless ringing, a full mailbox, a staff member who sounds harried. Then ask the owner what they think happens to those callers. Most have never listened to their own line as a customer. The gap between what they assume and what you heard is the entire sale, and you did not have to explain a single model or latency figure to make it.',
          },
          {
            title: 'Scope the first agent narrowly',
            body: 'Do not sell a receptionist that does everything. Sell one that handles the three intents that make money: book an appointment, answer the two questions everyone asks (hours, location, pricing range), and route anything urgent to a human immediately. A narrow agent that never embarrasses the client beats a broad one that occasionally does. You can widen scope in month two, once the client trusts the thing and has seen the transcripts.',
          },
          {
            title: 'Price on outcomes and per location',
            body: 'Flat monthly per location, priced against recovered bookings, keeps the relationship simple and your margin private. Per-minute pricing hands the client a meter to stare at and turns every busy month into a billing conversation. Include the reporting in the fee — the client should receive a monthly view of calls handled, appointments booked, transfers to staff, and questions the agent could not answer, because that last list is your upsell roadmap and their proof of value.',
          },
          {
            title: 'Show the client their own workspace',
            body: 'The single biggest trust unlock in this business is letting the client see their own calls. Transcripts, outcomes, what the agent said, when it handed off. Agencies that hide the dashboard get asked to justify the invoice; agencies that hand over a branded workspace get asked what else the agent could handle. That means isolation is a sales feature, not just an architecture requirement: one client must never be able to see another’s calls, and the interface they log into should carry your brand rather than your vendor’s.',
          },
          {
            title: 'The second client is where you decide build or buy',
            body: 'One agent for one business is a project. The second client arrives with different intents, a different calendar, different transfer rules, and different consent requirements, and suddenly you are forking prompts, sharing an account, and unable to show either client what their agent did. That is not a scaling problem, it is a missing operating layer: isolated workspaces, branding as configuration, per-client usage, a spec you can version, and a test call you can run before pointing real telephony at anything. Build that yourself and it becomes your product; buy it and your product stays the client relationship you are actually good at.',
          },
          {
            title: 'Who this playbook is not for',
            body: 'It is not for anyone whose plan is volume cold outreach — that use is blocked by default in VoiceForge and it burns the local reputation this business depends on. It is not for agencies that want to sell one agent and never touch it again; the value here compounds through iteration on real transcripts. And it is not a shortcut around knowing the client’s business. The agent is only as good as the call flow you understood well enough to specify.',
          },
        ]}
        related={[
          { href: '/for-agencies', label: 'The agency operating layer' },
          { href: '/templates/ai-receptionist', label: 'AI receptionist template' },
          { href: '/resources/white-label-ai-voice-agents', label: 'White-label delivery guide' },
          { href: '/resources/ai-call-consent', label: 'Consent and compliance basics' },
        ]}
        faqs={faqs}
      />
    </>
  );
}
