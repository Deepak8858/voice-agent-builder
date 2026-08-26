import { JsonLd, pageMetadata } from '@/lib/seo';
import { PRICING_FAQ } from '@/lib/billing-copy';
import { faqPageJsonLd, pricingProductJsonLd } from './pricing-structured-data';

export const metadata = pageMetadata(
  'VoiceForge AI Pricing | Plans for Voice Agents',
  'Compare VoiceForge plans for building, testing, deploying, monitoring, and white-labeling governed AI voice agents.',
  '/pricing',
);

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <JsonLd data={[pricingProductJsonLd(), faqPageJsonLd(PRICING_FAQ)]} />
      {children}
    </>
  );
}
