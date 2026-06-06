import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { apiFetch, ApiCallError } from '@/lib/api';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { SubscriptionStatusBanner } from '@/components/billing/subscription-status-banner';
import type { SessionUser } from '@voiceforge/shared';
export const dynamic = 'force-dynamic';

async function requireDashboardUser() {
  try {
    await apiFetch<SessionUser>('/auth/me');
  } catch (err) {
    if (err instanceof ApiCallError && err.status === 401) {
      redirect('/sign-in');
    }
    throw err;
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireDashboardUser();
  return (
    <div className="flex min-h-dvh flex-1 bg-[radial-gradient(circle_at_top_left,rgba(220,38,38,0.08),transparent_32rem),linear-gradient(180deg,var(--background),var(--background))]">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[92rem] flex-1 flex-col px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
          <Suspense fallback={null}>
            <SubscriptionStatusBanner />
          </Suspense>
          {children}
        </div>
      </div>
    </div>
  );
}
