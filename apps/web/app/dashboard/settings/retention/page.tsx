'use client';
import { useState } from 'react';
import { useApi } from '@/lib/use-api';
import { FormSection, PageHeader, StatCard, StatusBadge } from '@/components/dashboard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Archive } from 'lucide-react';

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
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <PageHeader
        eyebrow="Governance"
        title="Data retention"
        description="Configure how long call records are retained before they are eligible for archival or deletion."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Retention period"
            value={`${retentionDays} days`}
            description={`${Math.round((retentionDays / 365) * 10) / 10} years`}
            icon={<Archive className="h-5 w-5" />}
          />
          <StatCard
            label="Allowed range"
            value="30–3650"
            description="Days supported by the workspace policy"
            tone="info"
          />
        </div>
      </PageHeader>

      <FormSection
        title="Retention policy"
        description="Choose a period that balances analytics needs, compliance requirements, and storage minimization."
      >
        <form onSubmit={save} className="space-y-4">
          <div>
            <Label htmlFor="retention-days">Retention period (days)</Label>
            <Input
              id="retention-days"
              type="number"
              min={30}
              max={3650}
              value={retentionDays}
              onChange={(e) => setRetentionDays(Number(e.target.value))}
              className="mt-1"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Current: {retentionDays} days ({Math.round((retentionDays / 365) * 10) / 10} years)
            </p>
          </div>
          {error && <StatusBadge status="error" />}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && <StatusBadge status="saved" />}
          <Button type="submit">Save retention policy</Button>
        </form>
      </FormSection>
    </div>
  );
}