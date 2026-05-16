'use client';
import { useState } from 'react';
import { useApi } from '@/lib/use-api';

export default function RetentionSettingsPage() {
  const [retentionDays, setRetentionDays] = useState(365);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const { call } = useApi();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await call('/v1/workspaces/me/retention', {
        method: 'PATCH',
        body: JSON.stringify({ retentionDays }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl">Data Retention</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Configure how long call records are retained. Range: 30–3650 days.
      </p>

      <form onSubmit={save} className="mt-8 space-y-4">
        <div>
          <label className="block text-sm font-medium">Retention period (days)</label>
          <input
            type="number"
            min={30}
            max={3650}
            value={retentionDays}
            onChange={e => setRetentionDays(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border bg-background px-3 py-2"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Current: {retentionDays} days ({Math.round(retentionDays / 365 * 10) / 10} years)
          </p>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && <p className="text-sm text-green-600">Saved!</p>}
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          Save
        </button>
      </form>
    </div>
  );
}