import { apiFetch } from '@/lib/api';
import { WhiteLabelPanel } from '@/components/white-label-panel';
import { PageHeader } from '@/components/dashboard';
import type { SessionUser } from '@voiceforge/shared';

export default async function WhiteLabelPage() {
  let me: SessionUser | null = null;
  let apiError: string | null = null;

  try {
    me = await apiFetch<SessionUser>('/auth/me');
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (apiError || !me) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          eyebrow="Agency brand"
          title="White label"
          description={
            <>
              Could not load settings:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{apiError}</code>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Agency brand"
        title="White label"
        description="Brand the dashboard for your agency with a logo, primary color, custom domain, and support email."
      />

      <WhiteLabelPanel workspaceId={me.active_workspace_id ?? ''} />
    </div>
  );
}
