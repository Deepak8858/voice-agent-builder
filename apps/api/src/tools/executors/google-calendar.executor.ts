import { Injectable, Logger } from '@nestjs/common';

export interface GoogleCalendarConfig {
  /** OAuth2 refresh token granted via Google's consent screen. */
  refresh_token: string;
  client_id?: string;
  client_secret?: string;
  /** Default calendar ID. Use "primary" for the user's default calendar. */
  calendar_id?: string;
}

export interface GoogleCalendarOperationInput {
  /** Operation: create_event | list_events | find_free_slot */
  operation: 'create_event' | 'list_events' | 'find_free_slot';
  /** Operation-specific arguments. */
  args?: Record<string, unknown>;
}

export interface GoogleCalendarResult {
  status: number;
  body: unknown;
  duration_ms: number;
}

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Google Calendar executor — uses the Google Calendar v3 REST API directly so we
 * don't need to ship the full `googleapis` SDK (it's ~10MB).
 *
 * Required tool config:
 *   {
 *     refresh_token: string,
 *     client_id?: string,         // falls back to env GOOGLE_OAUTH_CLIENT_ID
 *     client_secret?: string,     // falls back to env GOOGLE_OAUTH_CLIENT_SECRET
 *     calendar_id?: string        // defaults to "primary"
 *   }
 *
 * Tool input arguments map per-operation:
 *   create_event:    { summary, start_iso, end_iso, attendees?, description?, time_zone? }
 *   list_events:     { time_min_iso?, time_max_iso?, max_results? }
 *   find_free_slot:  { duration_minutes, time_min_iso, time_max_iso, time_zone? }
 */
@Injectable()
export class GoogleCalendarExecutor {
  private readonly logger = new Logger(GoogleCalendarExecutor.name);

  async execute(
    config: GoogleCalendarConfig,
    input: GoogleCalendarOperationInput,
  ): Promise<GoogleCalendarResult> {
    if (!config.refresh_token) {
      throw new Error('google_calendar tool config missing refresh_token');
    }

    const t0 = Date.now();
    const accessToken = await this.exchangeRefreshToken(config);
    const calendarId = config.calendar_id ?? 'primary';
    const args = input.args ?? {};

    switch (input.operation) {
      case 'create_event':
        return this.createEvent(accessToken, calendarId, args, t0);
      case 'list_events':
        return this.listEvents(accessToken, calendarId, args, t0);
      case 'find_free_slot':
        return this.findFreeSlot(accessToken, calendarId, args, t0);
      default:
        throw new Error(`Unknown operation: ${input.operation}`);
    }
  }

  private async exchangeRefreshToken(config: GoogleCalendarConfig): Promise<string> {
    const clientId = config.client_id ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = config.client_secret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured');
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: config.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: HTTP ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as AccessTokenResponse;
    return json.access_token;
  }

  private async createEvent(
    accessToken: string,
    calendarId: string,
    args: Record<string, unknown>,
    t0: number,
  ): Promise<GoogleCalendarResult> {
    const summary = String(args.summary ?? 'Booking via VoiceForge');
    const startIso = String(args.start_iso ?? '');
    const endIso = String(args.end_iso ?? '');
    if (!startIso || !endIso) throw new Error('start_iso and end_iso are required');
    const timeZone = (args.time_zone as string) ?? 'UTC';
    const attendees = Array.isArray(args.attendees)
      ? (args.attendees as string[]).map((email) => ({ email }))
      : undefined;

    const body = {
      summary,
      description: (args.description as string) ?? undefined,
      start: { dateTime: startIso, timeZone },
      end: { dateTime: endIso, timeZone },
      ...(attendees ? { attendees } : {}),
    };

    return this.callApi(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      'POST',
      accessToken,
      body,
      t0,
    );
  }

  private async listEvents(
    accessToken: string,
    calendarId: string,
    args: Record<string, unknown>,
    t0: number,
  ): Promise<GoogleCalendarResult> {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(Number(args.max_results ?? 10), 50)),
    });
    if (args.time_min_iso) params.set('timeMin', String(args.time_min_iso));
    if (args.time_max_iso) params.set('timeMax', String(args.time_max_iso));
    return this.callApi(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      'GET',
      accessToken,
      undefined,
      t0,
    );
  }

  private async findFreeSlot(
    accessToken: string,
    calendarId: string,
    args: Record<string, unknown>,
    t0: number,
  ): Promise<GoogleCalendarResult> {
    const durationMinutes = Number(args.duration_minutes ?? 30);
    const timeMin = String(args.time_min_iso ?? '');
    const timeMax = String(args.time_max_iso ?? '');
    if (!timeMin || !timeMax) throw new Error('time_min_iso and time_max_iso are required');

    const fb = await this.callApi(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      'POST',
      accessToken,
      {
        timeMin,
        timeMax,
        timeZone: (args.time_zone as string) ?? 'UTC',
        items: [{ id: calendarId }],
      },
      t0,
    );
    const busy =
      ((fb.body as Record<string, Record<string, Array<{ start: string; end: string }>>>)
        .calendars?.[calendarId]?.busy as Array<{ start: string; end: string }>) ?? [];
    const slot = pickFreeSlot(timeMin, timeMax, busy, durationMinutes);
    return {
      status: slot ? 200 : 204,
      body: slot ?? { message: 'no free slot found' },
      duration_ms: Date.now() - t0,
    };
  }

  private async callApi(
    url: string,
    method: string,
    accessToken: string,
    body: unknown,
    t0: number,
  ): Promise<GoogleCalendarResult> {
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
    return { status: res.status, body: parsed, duration_ms: Date.now() - t0 };
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
