import { SettingsPanel } from '@/components/settings-panel';
import { PageHeader } from '@/components/dashboard';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Workspace admin"
        title="Settings"
        description="Manage your account, workspace team, audit logs, and operational controls."
      />
      <SettingsPanel />
    </div>
  );
}