import { apiFetch } from '@/lib/api';
import { WhiteLabelPanel } from '@/components/white-label-panel';
import type { SessionUser } from '@voiceforge/shared';

export default async function WhiteLabelPage() {
  const me = await apiFetch<SessionUser>('/auth/me');

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
