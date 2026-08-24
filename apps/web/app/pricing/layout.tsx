import { JsonLd, pageMetadata } from '@/lib/seo';
import { siteUrl } from '@/lib/site-url';

export const metadata = pageMetadata(
  'VoiceForge AI Pricing | Plans for Voice Agents',
  'Compare VoiceForge plans for building, testing, deploying, monitoring, and white-labeling governed AI voice agents.',
  '/pricing',
);

const productData = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'VoiceForge AI',
  description: 'A spec-first voice AI operating system for governed client deployments.',
  brand: { '@type': 'Brand', name: 'VoiceForge AI' },
  offers: [
    { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD', url: `${siteUrl}/pricing` },
    {
      '@type': 'Offer',
      name: 'Starter',
      price: '49',
      priceCurrency: 'USD',
      url: `${siteUrl}/pricing`,
    },
    {
      '@type': 'Offer',
      name: 'Growth',
      price: '149',
      priceCurrency: 'USD',
      url: `${siteUrl}/pricing`,
    },
    {
      '@type': 'Offer',
      name: 'Enterprise',
      price: '499',
      priceCurrency: 'USD',
      url: `${siteUrl}/pricing`,
    },
  ],
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <JsonLd data={productData} />
      {children}
    </>
  );
}
