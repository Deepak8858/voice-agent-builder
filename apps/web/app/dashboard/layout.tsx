import { Suspense } from 'react';
import { requireSessionUser } from '@/lib/api';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { SubscriptionStatusBanner } from '@/components/billing/subscription-status-banner';
import { AuthGate } from '@/components/auth/auth-gate';
import { PostHogIdentityBridge } from '@/components/analytics/posthog-identity-bridge';
export const dynamic = 'force-dynamic';

/**
 * Identity is the only thing here that needs the session, and it renders
 * nothing visible. Isolating it behind its own Suspense boundary means the
 * layout no longer awaits `/auth/me` before the sidebar and page shell are
 * streamed — previously every dashboard navigation held back the entire HTML
 * response for that round trip.
 *
 * This does not relax authorization: `requireSessionUser` still redirects on a
 * 401, `middleware.ts` still rejects unauthenticated navigations, and each
 * page's own data fetch is authorized server-side by the API.
 */
async function DashboardIdentity() {
  const user = await requireSessionUser('/dashboard');
  // Only the two opaque IDs cross into the browser analytics boundary.
  return <PostHogIdentityBridge userId={user.id} workspaceId={user.active_workspace_id} />;
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-1 bg-[radial-gradient(circle_at_top_left,rgba(220,38,38,0.08),transparent_32rem),linear-gradient(180deg,var(--background),var(--background))]">
      <Suspense fallback={null}>
        <DashboardIdentity />
      </Suspense>
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[92rem] flex-1 flex-col px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
          <Suspense fallback={null}>
            <SubscriptionStatusBanner />
          </Suspense>
          <AuthGate>
            {children}
          </AuthGate>
        </div>
      </div>
    </div>
  );
}
