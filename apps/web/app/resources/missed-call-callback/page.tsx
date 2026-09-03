import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, faqJsonLd, pageMetadata, techArticleJsonLd } from '@/lib/seo';

export const metadata = pageMetadata(
  'Missed-Call Callback: The Highest-ROI Voice Agent',
  'Every missed call at a local business is a customer calling a competitor next. The missed-call callback agent is the simplest voice deployment that pays.',
  '/resources/missed-call-callback',
);

const faqs = [
  {
    question: 'What is a missed-call callback agent?',
    answer:
      'An AI voice agent that calls a customer back within about a minute of their call going unanswered. The customer already tried to reach the business, so the callback is expected and welcome: the agent apologises for the miss, handles the booking or question directly, and transfers anything urgent to staff with context.',
  },
  {
    question: 'Why is it the highest-ROI first deployment?',
    answer:
      'Three reasons. The intent is maximal — this person dialled the number themselves minutes ago. The consent posture is the cleanest available — returning a customer’s own call, promptly and limited to the reason they called, is the least ambiguous outbound purpose there is, though it is inquiry-scoped rather than blanket permission and the compliance gate still verifies the consent record before dialing. And the baseline is zero — without it, a large fraction of missed calls simply never reconnect, because callers who reach voicemail rarely leave a message and frequently call the next result on the list.',
  },
  {
    question: 'How many calls do local businesses actually miss?',
    answer:
      'Industry studies put it somewhere between a quarter and half of inbound calls for small service businesses, concentrated at lunch, evenings, and weekends — exactly when customers are free to call. The precise number matters less than the pattern: the misses cluster in the hours when buying intent is highest and staffing is lowest. A business can measure its own gap in one month of call logs.',
  },
  {
    question: 'Is a callback within a minute really necessary?',
    answer:
      'Yes, and the reason is behavioral rather than technical: the caller is still in buying mode, phone in hand, often still looking at search results. Called back in a minute, the conversation continues where it would have started. Called back in three hours, the job is booked with whoever answered on the second dial.',
  },
  {
    question: 'What does the compliance check look like for callbacks?',
    answer:
      'Missed-call callback is a permitted purpose in VoiceForge, and it still passes the full gate before dialing: the callback targets the number that just called, within lawful calling hours, with AI disclosure and recording notice, respecting any prior opt-out. Cold calling remains blocked by default — a callback agent cannot be quietly repointed at a purchased list.',
  },
];

export default function MissedCallCallbackPage() {
  return (
    <>
      <JsonLd
        data={techArticleJsonLd({
          headline: 'Missed-Call Callback: The Highest-ROI Voice Agent',
          description:
            'Why the missed-call callback agent is the best first voice deployment for local businesses: maximal intent, clean consent, zero baseline.',
          path: '/resources/missed-call-callback',
          datePublished: '2026-09-02',
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
          { name: 'Missed-call callback', path: '/resources/missed-call-callback' },
        ])}
      />
      <JsonLd data={faqJsonLd(faqs)} />
      <SeoPage
        eyebrow="The first deployment that pays"
        title="A missed call is a customer mid-purchase"
        intro="Nobody calls a plumber recreationally. The person whose call just rang out was trying to give the business money, and the default outcome — voicemail, no message, call the next listing — is the most expensive silence in local business. The callback agent exists to interrupt that default within sixty seconds."
        sections={[
          {
            title: 'Why missed calls cluster where they hurt most',
            body: 'Customers call service businesses when the customer is free: lunch breaks, after work, Saturday morning. Those are precisely the windows when a two-person front desk is slammed or gone. The result is a structural mismatch — peak buying intent lands on minimum answering capacity, week after week. Hiring against those spikes means paying for idle hours; ignoring them means donating the calls to whoever answers next.',
          },
          {
            title: 'The economics of one recovered call',
            body: 'The arithmetic that sells this deployment fits on a napkin. Take the client’s average job value — a few hundred for a plumber, four figures over a patient’s first year for a dental practice. Count last month’s missed calls from the phone system log. Assume conservatively that a fraction of them were new business. One recovered booking a week typically pays for the entire platform several times over, and the client can audit every number in the calculation because it is their own call log.',
          },
          {
            title: 'What a good callback sounds like',
            body: 'Within about a minute of the missed call: “Hi, this is the assistant for Smith Plumbing — sorry we missed you just now. Are you calling about a repair, a quote, or something urgent?” It discloses what it is, gets to the caller’s purpose in one turn, books directly into the calendar, and hands anything urgent to a human immediately with the context attached. It does not pretend to be a person, and it does not trap the caller in a menu. The bar is not “impressive AI”; it is “better than the voicemail that was about to happen.”',
          },
          {
            title: 'Why this is the cleanest outbound call in the product',
            body: 'Returning a call the customer just made, promptly and about the reason they called, is the least ambiguous outbound purpose that exists — but it is inquiry-scoped, not blanket consent. Regulators classify AI-generated voices as artificial or prerecorded, so the callback must stay within the scope of the customer’s own contact, and anything broader — promotions, cross-selling, unrelated follow-up — needs its own prior express written consent. VoiceForge still runs the full gate before the callback goes out: calling window, AI disclosure, recording notice, opt-out state, DNC posture. And because cold solicitation is blocked by default at the engine level, the callback agent cannot later be repointed at a purchased lead list by an enthusiastic marketer. The constraint is the client’s protection, and it is worth saying so in the sales conversation.',
          },
          {
            title: 'Measure it like a funnel, not a gadget',
            body: 'The deployment is working when the client’s numbers say so: missed calls detected, callbacks connected, conversations that became bookings, transfers to staff, and revenue attributed to recovered calls. All of it lives in the client’s workspace with transcripts attached, which turns the monthly report from an invoice justification into an upsell conversation — the questions the agent could not answer are the client’s next agent.',
          },
          {
            title: 'Where it fits in the agency motion',
            body: 'Missed-call callback is the wedge deployment: narrow scope, measurable payoff, no change to how the business answers its phone when staff are available. It creates the trust and the transcript history that make the fuller receptionist deployment an obvious second step — and it pairs naturally with after-hours lead callback, which applies the same machinery to form fills instead of missed calls. Start where the loss is provable.',
          },
        ]}
        related={[
          { href: '/resources/appointment-setter-coverage', label: 'The 12-hour setter problem' },
          { href: '/templates/ai-receptionist', label: 'AI receptionist template' },
          { href: '/resources/sell-ai-receptionists', label: 'The agency sales playbook' },
          { href: '/compliance', label: 'How the compliance gate works' },
        ]}
        faqs={faqs}
      />
    </>
  );
}
