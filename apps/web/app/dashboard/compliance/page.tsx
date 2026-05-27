import { apiFetch } from '@/lib/api';
import { CompliancePanel } from '@/components/compliance-panel';
import { PageHeader } from '@/components/dashboard';
import type { SessionUser } from '@voiceforge/shared';

export default async function CompliancePage() {
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
          eyebrow="Governance"
          title="Compliance"
          description={
            <>
              Could not load compliance:{' '}
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
        eyebrow="Governance"
        title="Compliance"
        description="Manage contacts, consent records, and the workspace Do-Not-Call list. Outbound calls are gated on these checks."
      />

      <CompliancePanel workspaceId={me.active_workspace_id ?? ''} />
    </div>
  );
}
