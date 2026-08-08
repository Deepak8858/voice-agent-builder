'use client';

import { SiteHeader } from '@/components/site-header';

/** Isolates client-only chrome from server layouts / static generation. */
export function ClientChrome() {
  return <SiteHeader />;
}
