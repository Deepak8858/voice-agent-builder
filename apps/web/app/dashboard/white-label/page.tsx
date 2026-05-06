import { apiFetch } from '@/lib/api';
import { WhiteLabelPanel } from '@/components/white-label-panel';
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
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">White label</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Could not load settings: <code className="text-xs bg-muted px-1 py-0.5 rounded">{apiError}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">White label</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Brand the dashboard for your agency: logo, primary color, custom domain, support email.
        </p>
      </div>

      <WhiteLabelPanel workspaceId={me.active_workspace_id} />
    </div>
  );
}
