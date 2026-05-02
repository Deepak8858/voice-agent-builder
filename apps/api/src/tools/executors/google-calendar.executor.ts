import { Injectable } from '@nestjs/common';
import type { ToolExecutor, ToolCallResult } from '../tools.service';

@Injectable()
export class GoogleCalendarExecutor implements ToolExecutor {
  readonly name = 'google_calendar';

  private async getAccessToken(config: Record<string, string>): Promise<string> {
    const { refresh_token, client_id, client_secret } = config;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: client_id ?? process.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: client_secret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const json = await res.json() as { access_token: string };
    return json.access_token;
  }

  async execute(params: Record<string, unknown>, config: Record<string, string>): Promise<ToolCallResult> {
    const accessToken = await this.getAccessToken(config);
    const calendarId = config.calendar_id ?? 'primary';

    if (params.operation === 'create_event') {
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: params.summary,
          start: { dateTime: params.start_iso, timeZone: params.time_zone ?? 'UTC' },
          end: { dateTime: params.end_iso, timeZone: params.time_zone ?? 'UTC' },
          attendees: ((params.attendees as string[]) ?? []).map((e) => ({ email: e })),
          description: params.description as string | undefined,
        }),
      });
      const event = await res.json() as { id: string };
      return { success: true, result: { eventId: event.id } };
    }

    if (params.operation === 'list_events') {
      const timeMin = (params.time_min_iso as string) ?? new Date().toISOString();
      const maxResults = String(params.max_results ?? 10);
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?timeMin=${encodeURIComponent(timeMin)}&maxResults=${maxResults}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const data = await res.json() as { items: Array<{ id: string; summary: string; start: { dateTime: string } }> };
      return { success: true, result: { events: data.items.map((e) => ({ id: e.id, summary: e.summary, start: e.start.dateTime })) } };
    }

    if (params.operation === 'find_free_slot') {
      const timeMin = new Date();
      const timeMax = new Date(timeMin.getTime() + 7 * 24 * 60 * 60 * 1000);
      const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          items: [{ id: calendarId }],
        }),
      });
      const data = await res.json() as { calendars: Record<string, { busy: Array<{ start: string; end: string }> }> };
      const busy = data.calendars[calendarId]?.busy ?? [];
      const durationMs = ((params.duration_minutes as number) ?? 30) * 60 * 1000;
      for (const gap of this.findGaps(busy, timeMin, timeMax, durationMs)) {
        return { success: true, result: { start: gap.start, end: gap.end } };
      }
      return { success: false, error: 'No free slot found in next 7 days' };
    }

    return { success: false, error: `Unknown operation: ${params.operation}` };
  }

  private findGaps(
    busy: Array<{ start: string; end: string }>,
    start: Date,
    end: Date,
    durationMs: number,
  ): Array<{ start: string; end: string }> {
    const sorted = busy
      .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const gaps: Array<{ start: string; end: string }> = [];
    let cursor = start;
    for (const b of sorted) {
      if (b.start.getTime() - cursor.getTime() >= durationMs) {
        gaps.push({ start: cursor.toISOString(), end: new Date(cursor.getTime() + durationMs).toISOString() });
      }
      cursor = new Date(Math.max(cursor.getTime(), b.end.getTime()));
    }
    return gaps;
  }
}