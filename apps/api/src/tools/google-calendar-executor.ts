import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../config/env';

export interface BookSlotArgs {
  full_name: string;
  phone: string;
  preferred_date: string; // YYYY-MM-DD
  preferred_time: string; // HH:mm (24h)
}

export interface BookSlotResult {
  event_id: string;
  html_link: string;
  summary: string;
  start: string;
}

@Injectable()
export class GoogleCalendarExecutor {
  constructor(private readonly prisma: PrismaService) {}

  async bookSlot(
    workspaceId: string,
    args: BookSlotArgs,
  ): Promise<BookSlotResult> {
    const config = await this.prisma.googleCalendarConfig.findUnique({
      where: { workspaceId },
    });

    if (!config) {
      throw new GoogleCalendarAuthError(
        'Google Calendar not connected for this workspace.',
      );
    }

    let accessToken = config.accessToken;

    if (new Date(config.tokenExpiry) <= new Date()) {
      accessToken = await this.refreshAccessToken(workspaceId, config.refreshToken);
      await this.prisma.googleCalendarConfig.update({
        where: { workspaceId },
        data: { accessToken },
      });
    }

    const startDateTime = `${args.preferred_date}T${args.preferred_time}:00`;
    const endDateTime = `${args.preferred_date}T${args.preferred_time}:00`;

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary: `Voice Agent Booking - ${args.full_name}`,
          description: `Booked by voice agent.\nPhone: ${args.phone}`,
          start: {
            dateTime: startDateTime,
            timeZone: 'UTC',
          },
          end: {
            dateTime: endDateTime,
            timeZone: 'UTC',
          },
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'email', minutes: 60 },
              { method: 'popup', minutes: 15 },
            ],
          },
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = (error as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`;
      throw new GoogleCalendarApiError(message, response.status);
    }

    const event = (await response.json()) as {
      id: string;
      htmlLink: string;
      summary: string;
      start: { dateTime: string };
    };

    return {
      event_id: event.id,
      html_link: event.htmlLink,
      summary: event.summary,
      start: event.start.dateTime,
    };
  }

  private async refreshAccessToken(workspaceId: string, refreshToken: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const msg = (error as { error_description?: string }).error_description ?? 'Token refresh failed';
      throw new GoogleCalendarAuthError(msg);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    return data.access_token;
  }
}

export class GoogleCalendarAuthError extends Error {
  readonly code = 'GOOGLE_CALENDAR_AUTH_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'GoogleCalendarAuthError';
  }
}

export class GoogleCalendarApiError extends Error {
  readonly code = 'GOOGLE_CALENDAR_API_ERROR';
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'GoogleCalendarApiError';
  }
}
