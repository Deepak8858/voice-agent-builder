import type { Metadata } from 'next';
import { siteUrl } from '@/lib/site-url';

const image = '/images/voiceforge-builder-preview.png';

export function pageMetadata(title: string, description: string, path: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      title,
      description,
      url: path,
      siteName: 'VoiceForge AI',
      images: [{ url: image, width: 1043, height: 552, alt: 'VoiceForge AI voice agent builder' }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  );
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${siteUrl}${item.path}`,
    })),
  };
}

/**
 * FAQPage node for answer engines. Only pass questions that are VISIBLY
 * rendered on the page (Google's guideline and ours: markup must mirror
 * on-page content, never invent hidden Q&A).
 */
export function faqJsonLd(faqs: { question: string; answer: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

/**
 * TechArticle node for resource guides. `datePublished`/`dateModified` are
 * ISO dates supplied by the page (kept manual so a deploy does not silently
 * bump freshness signals).
 */
export function techArticleJsonLd(args: {
  headline: string;
  description: string;
  path: string;
  datePublished: string;
  dateModified?: string;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: args.headline,
    description: args.description,
    url: `${siteUrl}${args.path}`,
    datePublished: args.datePublished,
    dateModified: args.dateModified ?? args.datePublished,
    author: { '@type': 'Organization', name: 'VoiceForge AI', url: siteUrl },
    publisher: { '@id': `${siteUrl}/#organization` },
    mainEntityOfPage: `${siteUrl}${args.path}`,
  };
}
