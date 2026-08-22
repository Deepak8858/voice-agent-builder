'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GoogleLogo } from '@/components/icons/google-logo';
import { useApi } from '@/lib/use-api';
import { CheckCircle, AlertTriangle, Trash2 } from 'lucide-react';

interface SessionUser { active_workspace_id: string; }

interface GoogleStatus {
  connected: boolean;
  status: string | null;
  scopes: string[];
}

const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/calendar.events': 'Calendar booking',
  'https://www.googleapis.com/auth/calendar.events.freebusy': 'Calendar availability',
  'https://www.googleapis.com/auth/gmail.send': 'Gmail send',
  'https://www.googleapis.com/auth/spreadsheets': 'Sheets append',
};

export default function GoogleSettingsPage() {
  const { call } = useApi();
  const searchParams = useSearchParams();
  const callbackError = searchParams.get('error');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    callbackError ? 'Google connection failed — please try again.' : null,
  );

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch(console.error);
  }, [call]);

  const refreshStatus = useCallback(() => {
    if (!workspaceId) return;
    setLoading(true);
    call<GoogleStatus>(`/workspaces/${workspaceId}/google/status`)
      .then(setStatus)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [workspaceId, call]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  async function handleConnect() {
    if (!workspaceId || connecting) return;
    setConnecting(true);
    setErrorMessage(null);
    try {
      // One click: fetch the consent URL and send the browser straight to
      // Google. No intermediate form or confirmation step.
      const { url } = await call<{ url: string }>(`/workspaces/${workspaceId}/google/authorize`);
      window.location.assign(url);
    } catch (err) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : 'Could not start the Google connect flow.');
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!workspaceId) return;
    if (!confirm('Disconnect Google Workspace? Provisioned Google tools will be disabled.')) return;
    setErrorMessage(null);
    try {
      await call(`/workspaces/${workspaceId}/google/disconnect`, { method: 'DELETE' });
      refreshStatus();
    } catch (err) {
      console.error(err);
      setErrorMessage(err instanceof Error ? err.message : 'Disconnect failed.');
    }
  }

  const needsReauth = status?.status === 'needs_reauth';
  const connected = Boolean(status?.connected);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Google Workspace</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One connection powers Calendar booking, Gmail send, and Sheets append tools for your agents.
        </p>
      </div>

      {errorMessage ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

      {!loading && connected && (
        <Card>
          <CardContent className="flex flex-col gap-4 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                </div>
                <div>
                  <p className="font-medium">Google Workspace connected</p>
                  <p className="text-xs text-muted-foreground">
                    Calendar, Gmail, and Sheets tools were provisioned automatically.
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleDisconnect}>
                <Trash2 className="h-3 w-3" />
                Disconnect
              </Button>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Granted access</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(status?.scopes ?? []).map((scope) => (
                  <Badge key={scope} variant="outline">
                    {SCOPE_LABELS[scope] ?? scope}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && !connected && (
        <Card>
          <CardContent className="flex flex-col gap-4 py-6">
            {needsReauth ? (
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-100">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                </div>
                <div>
                  <p className="font-medium">Google access expired</p>
                  <p className="text-xs text-muted-foreground">
                    Google revoked or expired the saved authorization. Reconnect to restore Calendar,
                    Gmail, and Sheets tools.
                  </p>
                </div>
              </div>
            ) : (
              <p className="max-w-2xl text-sm text-muted-foreground">
                Connect your Google account once and VoiceForge provisions ready-to-use agent tools for
                booking calendar appointments, sending emails, and logging rows to a spreadsheet.
              </p>
            )}

            {/* Standard "Sign in with Google" control per Google brand
                guidelines: white background, subtle border, Roboto-ish label,
                official multicolor G. */}
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting || !workspaceId}
              className="inline-flex h-10 w-fit items-center gap-3 rounded-md border border-[#dadce0] bg-white px-3 text-sm font-medium text-[#3c4043] shadow-sm transition hover:bg-[#f8f9fa] hover:shadow disabled:cursor-not-allowed disabled:opacity-60"
            >
              <GoogleLogo className="h-[18px] w-[18px]" />
              {connecting
                ? 'Redirecting to Google...'
                : needsReauth
                  ? 'Reconnect with Google'
                  : 'Connect with Google'}
            </button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
