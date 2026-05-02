import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import type { ToolCallResult, ToolExecutor } from '../tools.service';

interface InlineConfig {
  /** Optional inline OAuth credentials. If provided, override per-workspace persisted config. */
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  calendar_id?: string;
  /** When set, look up persisted GoogleCalendarConfig for this workspaceId. */
  workspace_id?: string;
}

interface OperationParams {
  operation: 'create_event' | 'list_events' | 'find_free_slot' | 'book_slot';
  [key: string]: unknown;
}

interface ResolvedCreds {
  accessToken: string;
  calendarId: string;
}

/**
 * Google Calendar tool executor. Talks to Calendar v3 REST and the OAuth2
 * token endpoint directly so we don't pull the ~10MB `googleapis` SDK as a
 * runtime dep.
 *
 * Two credential sources, in priority order:
 *  1. Persisted `GoogleCalendarConfig` row keyed by `workspace_id` (preferred;
 *     supports refresh-token rotation + per-workspace OAuth).
 *  2. Inline `refresh_token` + `client_id` + `client_secret` in the tool's
 *     config blob (for ad-hoc / testing).
 *
 * Operations:
 *  - create_event   { summary, start_iso, end_iso, attendees?, description?, time_zone? }
 *  - list_events    { time_min_iso?, time_max_iso?, max_results? }
 *  - find_free_slot { duration_minutes, time_min_iso, time_max_iso, time_zone? }
 *  - book_slot      alias for create_event with sensible defaults from voice agents
 */
@Injectable()
export class GoogleCalendarExecutor implements ToolExecutor {
  readonly name = 'google_calendar';
  private readonly logger = new Logger(GoogleCalendarExecutor.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute(
    params: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const op = params as OperationParams;
    const cfg = config as InlineConfig;
    let creds: ResolvedCreds;
    try {
      creds = await this.resolveCreds(cfg);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    try {
      switch (op.operation) {
        case 'create_event':
        case 'book_slot':
          return this.createEvent(creds, op);
        case 'list_events':
          return this.listEvents(creds, op);
        case 'find_free_slot':
          return this.findFreeSlot(creds, op);
        default:
          return { success: false, error: `Unknown operation: ${op.operation}` };
      }
    } catch (err) {
      this.logger.warn(`Google Calendar ${op.operation} failed: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  }

  // ------------------------------------------------------------------------
  // Credential resolution
  // ------------------------------------------------------------------------

  private async resolveCreds(cfg: InlineConfig): Promise<ResolvedCreds> {
    if (cfg.workspace_id) {
      return this.credsFromPrisma(cfg.workspace_id);
    }
    if (cfg.refresh_token) {
      return this.credsFromInline(cfg);
    }
    throw new Error(
      'google_calendar tool config requires either workspace_id (persisted OAuth) or refresh_token (inline).',
    );
  }

  private async credsFromPrisma(workspaceId: string): Promise<ResolvedCreds> {
    const row = await this.prisma.googleCalendarConfig.findUnique({
      where: { workspaceId },
    });
    if (!row) {
      throw new Error(`Google Calendar not connected for workspace ${workspaceId}.`);
    }
    let accessToken = row.accessToken;
    if (new Date(row.tokenExpiry).getTime() <= Date.now() + 60_000) {
      // Refresh 60s before expiry to avoid race.
      const refreshed = await this.refreshAccessToken(row.refreshToken);
      accessToken = refreshed.access_token;
      const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
      await this.prisma.googleCalendarConfig.update({
        where: { workspaceId },
        data: { accessToken, tokenExpiry: expiresAt },
      });
    }
    return { accessToken, calendarId: row.calendarId };
  }

  private async credsFromInline(cfg: InlineConfig): Promise<ResolvedCreds> {
    const refreshed = await this.refreshAccessToken(
      cfg.refresh_token!,
      cfg.client_id,
      cfg.client_secret,
    );
    return {
      accessToken: refreshed.access_token,
      calendarId: cfg.calendar_id ?? 'primary',
    };
  }

  private async refreshAccessToken(
    refreshToken: string,
    clientIdOverride?: string,
    clientSecretOverride?: string,
  ): Promise<{ access_token: string; expires_in: number }> {
    const clientId = clientIdOverride ?? env.GOOGLE_CLIENT_ID;
    const clientSecret = clientSecretOverride ?? env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured.');
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google token refresh failed: HTTP ${res.status} ${text}`);
    }
    return (await res.json()) as { access_token: string; expires_in: number };
  }

  // ------------------------------------------------------------------------
  // Operations
  // ------------------------------------------------------------------------

  private async createEvent(
    creds: ResolvedCreds,
    op: OperationParams,
  ): Promise<ToolCallResult> {
    const summary = String(op.summary ?? 'Booking via VoiceForge');
    const startIso = String(op.start_iso ?? '');
    const endIso = String(op.end_iso ?? '');
    if (!startIso || !endIso) {
      return { success: false, error: 'start_iso and end_iso are required' };
    }
    const timeZone = (op.time_zone as string) ?? 'UTC';
    const attendees = Array.isArray(op.attendees)
      ? (op.attendees as string[]).map((email) => ({ email }))
      : undefined;

    const body = {
      summary,
      description: (op.description as string) ?? undefined,
      start: { dateTime: startIso, timeZone },
      end: { dateTime: endIso, timeZone },
      ...(attendees ? { attendees } : {}),
    };

    return this.callApi(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(creds.calendarId)}/events`,
      'POST',
      creds.accessToken,
      body,
    );
  }

  private async listEvents(
    creds: ResolvedCreds,
    op: OperationParams,
  ): Promise<ToolCallResult> {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(Number(op.max_results ?? 10), 50)),
    });
    if (op.time_min_iso) params.set('timeMin', String(op.time_min_iso));
    if (op.time_max_iso) params.set('timeMax', String(op.time_max_iso));
    return this.callApi(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(creds.calendarId)}/events?${params}`,
      'GET',
      creds.accessToken,
    );
  }

  private async findFreeSlot(
    creds: ResolvedCreds,
    op: OperationParams,
  ): Promise<ToolCallResult> {
    const durationMinutes = Number(op.duration_minutes ?? 30);
    const timeMin = String(op.time_min_iso ?? '');
    const timeMax = String(op.time_max_iso ?? '');
    if (!timeMin || !timeMax) {
      return { success: false, error: 'time_min_iso and time_max_iso are required' };
    }
    const fb = await this.callApi(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      'POST',
      creds.accessToken,
      {
        timeMin,
        timeMax,
        timeZone: (op.time_zone as string) ?? 'UTC',
        items: [{ id: creds.calendarId }],
      },
    );
    if (!fb.success) return fb;
    const body = fb.result as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    };
    const busy = body.calendars?.[creds.calendarId]?.busy ?? [];
    const slot = pickFreeSlot(timeMin, timeMax, busy, durationMinutes);
    return slot
      ? { success: true, result: slot }
      : { success: false, error: 'no free slot found in window' };
  }

  // ------------------------------------------------------------------------
  // HTTP helper
  // ------------------------------------------------------------------------

  private async callApi(
    url: string,
    method: string,
    accessToken: string,
    body?: unknown,
  ): Promise<ToolCallResult> {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (res.status >= 200 && res.status < 300) {
      return { success: true, result: parsed };
    }
    const errMsg =
      (parsed as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    return { success: false, error: errMsg, result: parsed };
  }
}

function pickFreeSlot(
  timeMin: string,
  timeMax: string,
  busy: Array<{ start: string; end: string }>,
  durationMinutes: number,
): { start: string; end: string } | null {
  const min = new Date(timeMin).getTime();
  const max = new Date(timeMax).getTime();
  const ms = durationMinutes * 60 * 1000;
  const sorted = [...busy]
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .sort((a, b) => a.start - b.start);

  let cursor = min;
  for (const window of sorted) {
    if (window.start - cursor >= ms) {
      return {
        start: new Date(cursor).toISOString(),
        end: new Date(cursor + ms).toISOString(),
      };
    }
    cursor = Math.max(cursor, window.end);
  }
  if (max - cursor >= ms) {
    return {
      start: new Date(cursor).toISOString(),
      end: new Date(cursor + ms).toISOString(),
    };
  }
  return null;
}
