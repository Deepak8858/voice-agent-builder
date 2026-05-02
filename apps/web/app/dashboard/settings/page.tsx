import { SettingsPanel } from '@/components/settings-panel';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </header>
      <SettingsPanel />
    </div>
  );
}