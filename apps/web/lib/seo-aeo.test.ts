import { describe, expect, it } from 'vitest';
import { faqJsonLd, techArticleJsonLd, breadcrumbJsonLd } from '@/lib/seo';

/**
 * AEO markup contract tests.
 *
 * Answer engines consume this JSON-LD verbatim; a malformed node silently
 * drops the page from rich results, so shape errors must fail CI.
 */
describe('faqJsonLd', () => {
  const faqs = [
    { question: 'Is it tested?', answer: 'Yes, in the browser before telephony.' },
    { question: 'Is cold calling supported?', answer: 'No, blocked by default.' },
  ];

  it('produces a valid FAQPage node', () => {
    const node = faqJsonLd(faqs) as Record<string, any>;
    expect(node['@context']).toBe('https://schema.org');
    expect(node['@type']).toBe('FAQPage');
    expect(node.mainEntity).toHaveLength(2);
  });

  it('wraps every question/answer in Question/Answer types', () => {
    const node = faqJsonLd(faqs) as Record<string, any>;
    for (const q of node.mainEntity) {
      expect(q['@type']).toBe('Question');
      expect(q.name.length).toBeGreaterThan(0);
      expect(q.acceptedAnswer['@type']).toBe('Answer');
      expect(q.acceptedAnswer.text.length).toBeGreaterThan(0);
    }
  });

  it('survives JSON serialization without undefined fields', () => {
    const parsed = JSON.parse(JSON.stringify(faqJsonLd(faqs)));
    expect(parsed.mainEntity[0].acceptedAnswer.text).toContain('browser');
  });
});

describe('techArticleJsonLd', () => {
  const args = {
    headline: 'How to Test an AI Voice Agent Before Launch',
    description: 'QA checklist for voice agents.',
    path: '/resources/test-ai-voice-agent',
    datePublished: '2026-08-24',
    dateModified: '2026-08-31',
  };

  it('produces a valid TechArticle node with absolute URLs', () => {
    const node = techArticleJsonLd(args) as Record<string, any>;
    expect(node['@type']).toBe('TechArticle');
    expect(node.url).toMatch(/^https?:\/\/.+\/resources\/test-ai-voice-agent$/);
    expect(node.mainEntityOfPage).toBe(node.url);
  });

  it('attributes authorship to the Organization entity', () => {
    const node = techArticleJsonLd(args) as Record<string, any>;
    expect(node.author['@type']).toBe('Organization');
    expect(node.publisher['@id']).toContain('#organization');
  });

  it('defaults dateModified to datePublished when omitted', () => {
    const node = techArticleJsonLd({ ...args, dateModified: undefined }) as Record<string, any>;
    expect(node.dateModified).toBe(args.datePublished);
  });

  it('uses ISO date format', () => {
    const node = techArticleJsonLd(args) as Record<string, any>;
    expect(node.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(node.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('breadcrumbJsonLd', () => {
  it('positions items 1-indexed in order', () => {
    const node = breadcrumbJsonLd([
      { name: 'Home', path: '/' },
      { name: 'Pricing', path: '/pricing' },
    ]) as Record<string, any>;
    expect(node.itemListElement[0].position).toBe(1);
    expect(node.itemListElement[1].position).toBe(2);
    expect(node.itemListElement[1].item).toMatch(/\/pricing$/);
  });
});
