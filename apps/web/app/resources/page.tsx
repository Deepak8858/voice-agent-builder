import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { JsonLd, breadcrumbJsonLd, pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata(
  'Voice Agent Testing and Agency Resources | VoiceForge',
  'Practical guides for testing, governing, white-labeling, and operating AI voice agents for local-business clients.',
  '/resources',
);

const guides = [
  {
    href: '/resources/why-voice-agents-fail',
    label: 'Reliability engineering',
    title: 'Why AI voice agents fail in production',
    description:
      'It is almost never the model. The failure map: shared state, turn detection, dropped transfers, unguarded tools, and unversioned change.',
  },
  {
    href: '/resources/test-ai-voice-agent',
    label: 'Testing and reliability',
    title: 'How to test an AI voice agent before launch',
    description:
      'A practical call-path checklist covering goals, tools, fallbacks, transfers, compliance, and production evidence.',
  },
  {
    href: '/resources/ai-call-consent',
    label: 'Compliance',
    title: 'Do you need consent to make AI phone calls?',
    description:
      'Consent, DNC, opt-out, disclosure, and calling windows — treated as pre-call checks in the execution path, not post-incident paperwork.',
  },
  {
    href: '/resources/sell-ai-receptionists',
    label: 'Agency playbook',
    title: 'How to sell AI receptionists to local businesses',
    description:
      'Qualify on missed-call arithmetic, open with the prospect’s own phone line, price on outcomes, and know where build becomes buy.',
  },
  {
    href: '/resources/appointment-setter-coverage',
    label: 'Agency operations',
    title: 'Your setter works 12 hours a week. Your leads do not.',
    description:
      'A 12-hour setter covers 7% of a 168-hour week. Move first-touch coverage to a compliant callback agent and reserve humans for the close.',
  },
  {
    href: '/resources/missed-call-callback',
    label: 'The wedge deployment',
    title: 'Missed-call callback: the highest-ROI voice agent',
    description:
      'Maximal intent, clean consent, zero baseline. Why calling back a missed call within a minute is the first deployment that provably pays.',
  },
  {
    href: '/resources/vapi-vs-retell-vs-openai-realtime',
    label: 'Choosing a runtime',
    title: 'Vapi vs Retell vs OpenAI Realtime',
    description:
      'Three different altitudes, not three competitors. Cascaded versus native speech-to-speech, latency budgets, and keeping the agent contract portable.',
  },
  {
    href: '/resources/white-label-ai-voice-agents',
    label: 'Agency delivery',
    title: 'White-label AI voice agents need an operating layer',
    description:
      'What agencies should give clients beyond a logo: isolation, approvals, visibility, governance, and outcome reporting.',
  },
];

export default function ResourcesPage() {
  return (
    <div className="min-h-screen bg-[#fbf6ea] text-[#07130f]">
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
        ])}
      />
      <section className="border-b border-[#d7d0c3] bg-[#07130f] px-6 py-20 text-[#fbf5e7] md:px-8 md:py-28">
        <div className="mx-auto max-w-5xl">
          <p className="font-mono text-sm uppercase tracking-[0.18em] text-[#bfff4a]">
            VoiceForge resources
          </p>
          <h1 className="mt-5 max-w-4xl font-serif text-4xl leading-tight md:text-6xl">
            Build voice agents that survive real calls
          </h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-[#dbe7dd]">
            Practical guidance for agencies and operators working on call-path testing, controlled
            releases, compliant follow-up, and client delivery.
          </p>
        </div>
      </section>
      <main className="mx-auto grid max-w-5xl gap-6 px-6 py-16 md:grid-cols-2 md:px-8 md:py-24">
        {guides.map((guide) => (
          <article
            key={guide.href}
            className="flex flex-col rounded-xl border border-[#d7d0c3] bg-white p-7"
          >
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-[#23594f]">
              {guide.label}
            </p>
            <h2 className="mt-4 font-serif text-3xl">{guide.title}</h2>
            <p className="mt-4 flex-1 leading-7 text-[#51615a]">{guide.description}</p>
            <Link
              href={guide.href}
              className="mt-7 inline-flex items-center gap-2 font-semibold text-[#23594f] hover:underline"
            >
              Read the guide <ArrowRight className="h-4 w-4" />
            </Link>
          </article>
        ))}
      </main>
    </div>
  );
}
