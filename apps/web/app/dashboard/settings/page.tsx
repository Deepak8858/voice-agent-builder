import { SettingsPanel } from '@/components/settings-panel';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account, workspace team, and audit logs.
        </p>
      </div>
      <SettingsPanel />
    </div>
  );
}
