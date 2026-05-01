import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { apiFetch } from '@/lib/api';
import type { SessionUser } from '@voiceforge/shared';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) {
    redirect('/');
  }
  let activeWorkspaceName: string | undefined;
  try {
    const me = await apiFetch<SessionUser>('/auth/me');
    activeWorkspaceName = me.active_workspace_name;
  } catch {
    // ignore — sidebar still renders without switcher
  }
  return (
    <div className="flex flex-1">
      <AppSidebar activeWorkspaceName={activeWorkspaceName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
