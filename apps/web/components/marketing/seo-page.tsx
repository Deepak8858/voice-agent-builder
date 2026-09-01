import Link from 'next/link';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Section = { title: string; body: string; bullets?: string[] };
type Faq = { question: string; answer: string };

export function SeoPage({
  eyebrow,
  title,
  intro,
  sections,
  related = [],
  faqs = [],
}: {
  eyebrow: string;
  title: string;
  intro: string;
  sections: Section[];
  related?: { href: string; label: string }[];
  faqs?: Faq[];
}) {
  return (
    <div className="min-h-screen bg-[#fbf6ea] text-[#07130f]">
      <section className="border-b border-[#d7d0c3] bg-[#07130f] px-6 py-20 text-[#fbf5e7] md:px-8 md:py-28">
        <div className="mx-auto max-w-5xl">
          <p className="font-mono text-sm uppercase tracking-[0.18em] text-[#bfff4a]">{eyebrow}</p>
          <h1 className="mt-5 max-w-4xl font-serif text-4xl leading-tight md:text-6xl">{title}</h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-[#dbe7dd]">{intro}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="bg-[#bfff4a] text-[#07130f] hover:bg-[#d3ff7a]">
              <Link href="/sign-up">
                Start building <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-white/25 bg-transparent text-white hover:bg-white/10 hover:text-white"
            >
              <Link href="/how-it-works">See how it works</Link>
            </Button>
          </div>
        </div>
      </section>
      <main className="mx-auto grid max-w-5xl gap-12 px-6 py-16 md:px-8 md:py-24">
        {sections.map((section) => (
          <section
            key={section.title}
            className="grid gap-5 border-b border-[#d7d0c3] pb-12 md:grid-cols-[0.8fr_1.2fr]"
          >
            <h2 className="font-serif text-3xl">{section.title}</h2>
            <div>
              <p className="text-lg leading-8 text-[#51615a]">{section.body}</p>
              {section.bullets ? (
                <ul className="mt-6 grid gap-3">
                  {section.bullets.map((item) => (
                    <li key={item} className="flex gap-3 text-[#34463e]">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#23594f]" />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
        ))}
        {related.length ? (
          <nav aria-label="Related pages">
            <h2 className="font-serif text-2xl">Explore VoiceForge</h2>
            <div className="mt-4 flex flex-wrap gap-3">
              {related.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md border border-[#23594f]/25 bg-white px-4 py-3 font-medium text-[#23594f] hover:bg-[#e8f2df]"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        ) : null}
        {faqs.length ? (
          <section aria-label="Frequently asked questions">
            <h2 className="font-serif text-3xl">Frequently asked questions</h2>
            <dl className="mt-6 grid gap-8">
              {faqs.map((faq) => (
                <div key={faq.question} className="border-b border-[#d7d0c3] pb-6">
                  <dt className="text-lg font-medium text-[#07130f]">{faq.question}</dt>
                  <dd className="mt-3 leading-7 text-[#51615a]">{faq.answer}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </main>
    </div>
  );
}
