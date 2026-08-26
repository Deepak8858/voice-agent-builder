import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { JsonLd, breadcrumbJsonLd, pageMetadata } from '@/lib/seo';
import { templateContent } from '@/lib/template-content';
import { templateListJsonLd } from './templates-structured-data';

export const metadata = pageMetadata(
  'AI Voice Agent Templates | VoiceForge',
  'Start with tested voice-agent templates for reception, dental clinics, real estate follow-up, appointment reminders, and order confirmation.',
  '/templates',
);

export default function TemplatesPage() {
  return (
    <div className="min-h-screen bg-[#fbf6ea] text-[#07130f]">
      <JsonLd
        data={[
          templateListJsonLd(),
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Templates', path: '/templates' },
          ]),
        ]}
      />
      <section className="bg-[#07130f] px-6 py-20 text-[#fbf5e7] md:px-8 md:py-28">
        <div className="mx-auto max-w-6xl">
          <p className="font-mono text-sm uppercase tracking-[0.18em] text-[#bfff4a]">
            Vertical starting points
          </p>
          <h1 className="mt-5 max-w-4xl font-serif text-5xl leading-tight md:text-6xl">
            AI voice agent templates built for real call paths
          </h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-[#dbe7dd]">
            Start with a shipped template, adapt it to the business, review the generated Agent
            Spec, and test every important path before publishing.
          </p>
        </div>
      </section>
      <main className="mx-auto max-w-6xl px-6 py-16 md:px-8 md:py-24">
        <div className="grid gap-5 md:grid-cols-2">
          {templateContent.map((template) => (
            <article
              key={template.slug}
              className="rounded-lg border border-[#d7d0c3] bg-white p-7"
            >
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#23594f]">
                {template.eyebrow}
              </p>
              <h2 className="mt-3 font-serif text-3xl">{template.name}</h2>
              <p className="mt-4 leading-7 text-[#51615a]">{template.intro}</p>
              <Link
                href={`/templates/${template.slug}`}
                className="mt-6 inline-flex items-center gap-2 font-semibold text-[#23594f]"
              >
                Explore template <ArrowRight className="h-4 w-4" />
              </Link>
            </article>
          ))}
        </div>
        <div className="mt-12 rounded-lg bg-[#e8f2df] p-8">
          <h2 className="font-serif text-3xl">Need a client-ready operating layer?</h2>
          <p className="mt-3 max-w-2xl text-[#51615a]">
            See how agencies isolate client workspaces, apply branding, and monitor outcomes without
            rebuilding the platform.
          </p>
          <Link href="/for-agencies" className="mt-5 inline-flex font-semibold text-[#23594f]">
            VoiceForge for agencies
          </Link>
        </div>
      </main>
    </div>
  );
}
