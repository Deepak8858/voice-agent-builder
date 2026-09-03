import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, faqJsonLd, pageMetadata, techArticleJsonLd } from '@/lib/seo';

export const metadata = pageMetadata(
  'The 12-Hour-a-Week Setter Problem for Agencies',
  'A human setter covers 12 hours a week. Leads arrive across all 168. The fix is not more setter hours — it is an AI agent on the compliant follow-up calls.',
  '/resources/appointment-setter-coverage',
);

const faqs = [
  {
    question: 'What is the setter coverage gap?',
    answer:
      'A part-time human setter works something like 12 hours a week — and those hours rarely match when leads actually arrive. Form fills happen at 9pm, missed calls happen during the lunch rush, weekend inquiries sit until Monday. The week has 168 hours; a 12-hour setter covers about 7% of them. Speed-to-lead research consistently shows contact and qualification rates collapse within minutes of a lead arriving, so most of the loss happens in hours nobody is working.',
  },
  {
    question: 'Can an AI agent replace an appointment setter?',
    answer:
      'It replaces the coverage, not the judgment. An AI agent answers or calls back instantly at any hour, asks the qualifying questions, books directly into the calendar, and hands anything ambiguous to a human with full context. The human setter stops being a phone-coverage schedule and becomes the closer for conversations that need one.',
  },
  {
    question: 'Is AI setter calling legal?',
    answer:
      'The compliant version is callback-based and inquiry-scoped: a form fill, missed call, or callback request can support a return call limited to that specific inquiry — it is not blanket consent, and regulators treat AI voices as artificial or prerecorded voices requiring prior express consent for outbound calls. The callback must stay on the caller’s own topic; using it to deliver broader marketing needs separate written consent. Cold outbound prospecting by AI is a different activity with a much harsher rulebook, and VoiceForge blocks cold solicitation by default. Every outbound callback still passes checks for consent, DNC status, opt-out state, calling windows, AI disclosure, and recording notice before it dials.',
  },
  {
    question: 'What does this cost compared to a human setter?',
    answer:
      'A part-time setter at 12 hours a week costs several hundred to over a thousand dollars a month depending on market, covers 7% of the week, and needs management, training, and re-hiring. An AI agent runs on a flat platform subscription, covers every hour, never quits, and produces a transcript of every conversation. The honest comparison is not cost per hour — it is cost per booked appointment.',
  },
  {
    question: 'How fast should a lead be called back?',
    answer:
      'Inside five minutes is the standard the speed-to-lead literature converges on; after that, contact rates drop off a cliff as the prospect moves on or a competitor answers first. No human schedule achieves five-minute response across nights, weekends, and lunch rushes. Instant response is precisely the thing software is good at.',
  },
];

export default function SetterCoveragePage() {
  return (
    <>
      <JsonLd
        data={techArticleJsonLd({
          headline: 'The 12-Hour-a-Week Setter Problem',
          description:
            'Why part-time human setter coverage loses leads across the other 156 hours, and how compliant AI callback agents close the gap.',
          path: '/resources/appointment-setter-coverage',
          datePublished: '2026-09-02',
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
          { name: 'Setter coverage', path: '/resources/appointment-setter-coverage' },
        ])}
      />
      <JsonLd data={faqJsonLd(faqs)} />
      <SeoPage
        eyebrow="Agency operations"
        title="Your setter works 12 hours a week. Your leads do not."
        intro="Agencies keep solving lead follow-up with a part-time human setter — and keep losing the same deals, because a 12-hour schedule covers 7% of a 168-hour week. The fix is not more setter hours. It is moving first-touch coverage to software and reserving the human for conversations that need one."
        sections={[
          {
            title: 'Do the coverage arithmetic once',
            body: 'Twelve hours a week sounds like meaningful coverage until you divide. A week has 168 hours. Leads from ads, forms, and missed calls arrive across most of them — evenings after work, weekends, the exact lunch rush when the client’s own staff cannot answer either. A 12-hour setter, perfectly scheduled, is present for about 7% of the moments a lead raises a hand. Every optimization of that schedule is rearranging a rounding error.',
          },
          {
            title: 'Speed-to-lead is the whole game',
            body: 'The follow-up literature has converged on an uncomfortable fact: the odds of contacting and qualifying a lead collapse within minutes of the inquiry, not hours. The prospect who filled your client’s form at 9:14pm is comparing three providers at 9:20pm. Whoever responds first frames the conversation; whoever responds Monday morning is a voicemail. A setter cannot fix this at any weekly hour count, because the problem is latency, not effort.',
          },
          {
            title: 'What the AI setter actually does',
            body: 'The compliant version is callback-based and stays inside the scope of the inquiry, and that matters. A form fill or a missed call can support a return call about that specific request — not a license for broader outreach, and the consent record for the number, purpose, and jurisdiction still has to exist and be checked. The agent calls back within a minute, discloses what it is, asks the three qualifying questions the client actually cares about, books a slot directly in the calendar, and writes the transcript and outcome to the client’s workspace. Anything ambiguous, urgent, or high-value transfers to a human with the context attached rather than a cold start.',
          },
          {
            title: 'What stays human',
            body: 'Judgment, negotiation, and the close. An agent that books discovery calls at 11pm makes the human setter more valuable per hour, not obsolete: their 12 hours stop being phone coverage and become the conversations that were already qualified. The agencies getting this right are not firing setters — they are reassigning them from answering to closing, and measuring both sides on the same funnel.',
          },
          {
            title: 'The compliance line you must not cross',
            body: 'Callback follow-up and cold prospecting are different activities under different rules, and blurring them is how agencies get their clients in trouble. VoiceForge draws the line in the execution path: cold sales calling is blocked by default, and every outbound callback passes the compliance gate — consent record, DNC/DND, opt-out state, calling window, AI disclosure, recording notice — before it dials. If a vendor pitches you an AI setter that will “call any list,” run.',
          },
          {
            title: 'How to sell this to your clients',
            body: 'Do not sell an AI setter. Sell the after-hours bookings the client is currently losing. Pull their missed-call log and their form-submission timestamps for one month, mark which arrived outside staffed hours, and price the recovered appointments against their own average job value. The pitch is their data plus arithmetic — the same qualification method as the receptionist sale, pointed at the follow-up funnel instead of the inbound line.',
          },
        ]}
        related={[
          { href: '/resources/sell-ai-receptionists', label: 'The agency sales playbook' },
          { href: '/templates/real-estate-lead-qualifier', label: 'Lead qualifier template' },
          { href: '/resources/ai-call-consent', label: 'Consent and the compliance gate' },
          { href: '/for-agencies', label: 'The agency operating layer' },
        ]}
        faqs={faqs}
      />
    </>
  );
}
