import { notFound } from 'next/navigation';
import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, pageMetadata } from '@/lib/seo';
import { getTemplate, templateContent } from '@/lib/template-content';

export function generateStaticParams() {
  return templateContent.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const template = getTemplate((await params).slug);
  if (!template) return {};
  return pageMetadata(
    `${template.title} | VoiceForge`,
    template.description,
    `/templates/${template.slug}`,
  );
}

export default async function TemplatePage({ params }: { params: Promise<{ slug: string }> }) {
  const template = getTemplate((await params).slug);
  if (!template) notFound();
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Templates', path: '/templates' },
          { name: template.name, path: `/templates/${template.slug}` },
        ])}
      />
      <SeoPage
        eyebrow={template.eyebrow}
        title={template.title}
        intro={template.intro}
        sections={template.sections}
        related={[
          { href: '/templates', label: 'All voice-agent templates' },
          { href: '/how-it-works', label: 'How VoiceForge works' },
          { href: '/compliance', label: 'Compliance controls' },
        ]}
      />
    </>
  );
}
