import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors';

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  async connectGoogleCalendar(args: {
    workspaceId: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiry: string;
  }): Promise<void> {
    await this.prisma.googleCalendarConfig.upsert({
      where: { workspaceId: args.workspaceId },
      create: {
        workspaceId: args.workspaceId,
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        tokenExpiry: new Date(args.tokenExpiry),
      },
      update: {
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        tokenExpiry: new Date(args.tokenExpiry),
      },
    });
  }

  async disconnectGoogleCalendar(workspaceId: string): Promise<void> {
    await this.prisma.googleCalendarConfig.delete({
      where: { workspaceId },
    }).catch(() => {
      // Best-effort: no config to delete
    });
  }

  async isConnected(workspaceId: string): Promise<boolean> {
    const config = await this.prisma.googleCalendarConfig.findUnique({
      where: { workspaceId },
    });
    return !!config;
  }

  /**
   * Book an appointment via the connected Google Calendar.
   * Tool: `book_appointment(date, time, duration_minutes)`.
   */
  async bookAppointment(args: {
    workspaceId: string;
    title: string;
    date: string; // YYYY-MM-DD
    time: string; // HH:MM
    durationMinutes: number;
    attendeePhone?: string;
    attendeeEmail?: string;
    description?: string;
  }): Promise<{ eventId: string; meetLink?: string }> {
    const config = await this.prisma.googleCalendarConfig.findUnique({
      where: { workspaceId: args.workspaceId },
    });
    if (!config) throw new AppError('CRM_NOT_CONFIGURED', 'Google Calendar not connected', 400);

    // Refresh token if expired
    const isExpired = new Date(config.tokenExpiry) < new Date();
    let accessToken = config.accessToken;
    if (isExpired) {
      this.logger.log('Google Calendar token expired — refresh not implemented in MVP');
      throw new AppError('CRM_NOT_CONFIGURED', 'Google Calendar token expired — re-connect required', 400);
    }

    const [hours, minutes] = args.time.split(':').map(Number);
    const startDateTime = new Date(`${args.date}T${args.time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + args.durationMinutes * 60 * 1000);

    const event = {
      summary: args.title,
      description: args.description ?? '',
      start: { dateTime: startDateTime.toISOString() },
      end: { dateTime: endDateTime.toISOString() },
      attendees: args.attendeeEmail
        ? [{ email: args.attendeeEmail, phone: args.attendeePhone }]
        : [],
    };

    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      this.logger.error(`Google Calendar API error: ${response.status}`);
      throw new AppError('CRM_NOT_CONFIGURED', 'Failed to create calendar event', 400);
    }

    const data = await response.json() as { id: string; hangoutLink?: string };
    return { eventId: data.id, meetLink: data.hangoutLink };
  }
}
