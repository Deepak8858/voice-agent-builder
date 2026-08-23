import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../common/safe-fetch';
import {
  GOOGLE_REAUTH_REQUIRED_MESSAGE,
  GoogleConnectionService,
} from '../../google-connection/google-connection.service';
import { redactGoogleSecrets } from './google-error-redaction';
import type { ToolExecutor, ToolCallResult, ToolExecutionContext } from '../tools.service';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * Calendar operations through the workspace's unified Google connection. The
 * access token is resolved at call time from GoogleConnectionService — never
 * from tool config, which stores the target calendar id only.
 */
@Injectable()
export class GoogleCalendarExecutor implements ToolExecutor {
  readonly name = 'google_calendar';
  private readonly logger = new Logger(GoogleCalendarExecutor.name);

  constructor(private readonly googleConnection: GoogleConnectionService) {}

  async execute(
    params: Record<string, unknown>,
    config: Record<string, string>,
    context?: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!context?.workspaceId) {
      return { success: false, error: 'Calendar tool requires a workspace-scoped invocation.' };
    }

    const operation = typeof params.operation === 'string' ? params.operation : '';
    if (!['create_event', 'list_events', 'find_free_slot'].includes(operation)) {
      return {
        success: false,
        error: 'operation must be create_event, list_events, or find_free_slot.',
      };
    }

    let accessToken: string;
    try {
      accessToken = await this.googleConnection.getUsableAccessToken(context.workspaceId);
    } catch (err) {
      return { success: false, error: reauthOrGenericError(err) };
    }

    const calendarId = config.calendar_id ?? 'primary';

    try {
      if (operation === 'create_event') {
        return await this.createEvent(accessToken, calendarId, params);
      }
      if (operation === 'list_events') {
        return await this.listEvents(accessToken, calendarId, params);
      }
      return await this.findFreeSlot(accessToken, calendarId, params);
    } catch (err) {
      this.logger.error(`Calendar ${operation} request failed: ${(err as Error).message}`);
      return { success: false, error: 'Google Calendar request failed — please try again shortly.' };
    }
  }

  private async createEvent(
    accessToken: string,
    calendarId: string,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    if (typeof params.summary !== 'string' || !params.summary.trim()) {
      return { success: false, error: 'summary is required to create an event.' };
    }
    if (typeof params.start_iso !== 'string' || typeof params.end_iso !== 'string') {
      return { success: false, error: 'start_iso and end_iso are required to create an event.' };
    }
    const attendees = Array.isArray(params.attendees)
      ? params.attendees.filter((a): a is string => typeof a === 'string')
      : [];

    // No retries: event creation is not idempotent — a timed-out request may
    // still have landed, and retrying would double-book.
    const response = await safeFetch(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary: params.summary,
          start: { dateTime: params.start_iso, timeZone: params.time_zone ?? 'UTC' },
          end: { dateTime: params.end_iso, timeZone: params.time_zone ?? 'UTC' },
          ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
          ...(typeof params.description === 'string' ? { description: params.description } : {}),
        }),
      },
    );
    const failure = await this.apiFailure(response);
    if (failure) return failure;

    const event = (await response.json().catch(() => ({}))) as {
      id?: string;
      htmlLink?: string;
    };
    return {
      success: true,
      result: { event_id: event.id ?? null, html_link: event.htmlLink ?? null },
    };
  }

  private async listEvents(
    accessToken: string,
    calendarId: string,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const timeMin =
      typeof params.time_min_iso === 'string' ? params.time_min_iso : new Date().toISOString();
    const maxResults = Math.min(Math.max(Number(params.max_results) || 10, 1), 50);
    const response = await safeFetch(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events` +
        `?timeMin=${encodeURIComponent(timeMin)}&maxResults=${maxResults}` +
        '&singleEvents=true&orderBy=startTime',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const failure = await this.apiFailure(response);
    if (failure) return failure;

    const data = (await response.json().catch(() => ({}))) as {
      items?: Array<{
        id?: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
      }>;
    };
    return {
      success: true,
      result: {
        events: (data.items ?? []).map((e) => ({
          id: e.id ?? null,
          summary: e.summary ?? '',
          start: e.start?.dateTime ?? e.start?.date ?? null,
        })),
      },
    };
  }

  private async findFreeSlot(
    accessToken: string,
    calendarId: string,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const timeMin = new Date();
    const timeMax = new Date(timeMin.getTime() + 7 * 24 * 60 * 60 * 1000);
    const response = await safeFetch(`${CALENDAR_BASE}/freeBusy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    const failure = await this.apiFailure(response);
    if (failure) return failure;

    const data = (await response.json().catch(() => ({}))) as {
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    };
    const busy = data.calendars?.[calendarId]?.busy ?? [];
    const durationMinutes = Number(params.duration_minutes) || 30;
    const durationMs = Math.min(Math.max(durationMinutes, 5), 8 * 60) * 60 * 1000;
    const slot = firstGap(busy, timeMin, timeMax, durationMs);
    if (!slot) {
      return { success: false, error: 'No free slot found in the next 7 days.' };
    }
    return { success: true, result: slot };
  }

  /** Convert a non-OK Google API response into a redacted failure result. */
  private async apiFailure(response: Response): Promise<ToolCallResult | null> {
    if (response.status === 401) {
      return { success: false, error: GOOGLE_REAUTH_REQUIRED_MESSAGE };
    }
    if (!response.ok) {
      this.logger.error(`Calendar API error: ${response.status}`);
      const detail = redactGoogleSecrets(await response.text().catch(() => ''));
      return {
        success: false,
        error: `Calendar API returned ${response.status}.${detail ? ` ${detail.slice(0, 300)}` : ''}`,
      };
    }
    return null;
  }
}

function firstGap(
  busy: Array<{ start: string; end: string }>,
  start: Date,
  end: Date,
  durationMs: number,
): { start: string; end: string } | null {
  const sorted = busy
    .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  let cursor = start;
  for (const b of sorted) {
    if (b.start.getTime() - cursor.getTime() >= durationMs) {
      return {
        start: cursor.toISOString(),
        end: new Date(cursor.getTime() + durationMs).toISOString(),
      };
    }
    cursor = new Date(Math.max(cursor.getTime(), b.end.getTime()));
  }
  if (end.getTime() - cursor.getTime() >= durationMs) {
    return {
      start: cursor.toISOString(),
      end: new Date(cursor.getTime() + durationMs).toISOString(),
    };
  }
  return null;
}

function reauthOrGenericError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(GOOGLE_REAUTH_REQUIRED_MESSAGE) || message.includes('re-connect required')) {
    return GOOGLE_REAUTH_REQUIRED_MESSAGE;
  }
  return redactGoogleSecrets(message);
}
