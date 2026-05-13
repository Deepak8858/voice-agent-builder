import { PricingPage } from '@/components/pricing-page';

export default async function Pricing() {
  const priceIds = {
    starter: process.env.NEXT_PUBLIC_STRIPE_STARTER_PRICE_ID ?? null,
    growth: process.env.NEXT_PUBLIC_STRIPE_GROWTH_PRICE_ID ?? null,
    enterprise: process.env.NEXT_PUBLIC_STRIPE_ENTERPRISE_PRICE_ID ?? null,
  };

  return <PricingPage priceIds={priceIds} />;
}