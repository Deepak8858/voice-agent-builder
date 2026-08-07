import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors';
import { EncryptionService } from '../security/encryption.service';
import { GoogleOAuthClient } from './google-oauth.client';

/**
 * Refresh this long before the recorded expiry. Google access tokens are
 * valid for an hour; refreshing slightly early avoids a race where the token
 * expires between our check and Google receiving the API call.
 */
const EXPIRY_SKEW_MS = 60_000;

interface CalendarCredentials {
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
}

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  /**
   * In-flight refreshes keyed by workspace. Two concurrent bookings for the
   * same workspace must not both call Google and then race each other's
   * writes; the second caller awaits the first one's result.
   */
  private readonly inFlightRefreshes = new Map<string, Promise<CalendarCredentials>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly googleOAuth: GoogleOAuthClient,
  ) {}

  async connectGoogleCalendar(args: {
    workspaceId: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiry: string;
  }): Promise<void> {
    const accessToken = this.encryptToken(args.accessToken);
    const refreshToken = this.encryptToken(args.refreshToken);
    const tokenExpiry = new Date(args.tokenExpiry);

    await this.prisma.googleCalendarConfig.upsert({
      where: { workspaceId: args.workspaceId },
      create: {
        workspaceId: args.workspaceId,
        accessToken,
        refreshToken,
        tokenExpiry,
      },
      update: {
        accessToken,
        refreshToken,
        tokenExpiry,
      },
    });
  }

  async disconnectGoogleCalendar(workspaceId: string): Promise<void> {
    this.inFlightRefreshes.delete(workspaceId);
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
    const credentials = await this.getUsableCredentials(args.workspaceId);

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
        Authorization: `Bearer ${credentials.accessToken}`,
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

  /**
   * Load this workspace's credentials, refreshing them first if the access
   * token is expired (or about to be). Always scoped by workspaceId, so one
   * tenant can never obtain another tenant's Google token.
   */
  private async getUsableCredentials(workspaceId: string): Promise<CalendarCredentials> {
    const config = await this.prisma.googleCalendarConfig.findUnique({
      where: { workspaceId },
    });
    if (!config) throw new AppError('CRM_NOT_CONFIGURED', 'Google Calendar not connected', 400);

    const credentials = this.readCredentials(config);
    if (!this.isExpired(credentials.tokenExpiry)) {
      return credentials;
    }

    return this.refreshCredentials(workspaceId, credentials);
  }

  /**
   * Refresh and persist. Concurrent callers for the same workspace share one
   * in-flight refresh so we issue a single token request and a single write.
   */
  private async refreshCredentials(
    workspaceId: string,
    current: CalendarCredentials,
  ): Promise<CalendarCredentials> {
    const existing = this.inFlightRefreshes.get(workspaceId);
    if (existing) return existing;

    const pending = this.performRefresh(workspaceId, current).finally(() => {
      // Clear on both success and failure so a transient error does not
      // permanently poison later refresh attempts for this workspace.
      this.inFlightRefreshes.delete(workspaceId);
    });

    this.inFlightRefreshes.set(workspaceId, pending);
    return pending;
  }

  private async performRefresh(
    workspaceId: string,
    current: CalendarCredentials,
  ): Promise<CalendarCredentials> {
    if (!current.refreshToken) {
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google Calendar token expired — re-connect required',
        400,
      );
    }

    const refreshed = await this.googleOAuth.refreshAccessToken(current.refreshToken);
    const refreshToken = refreshed.refreshToken ?? current.refreshToken;

    const next: CalendarCredentials = {
      accessToken: refreshed.accessToken,
      refreshToken,
      tokenExpiry: refreshed.expiresAt,
    };

    try {
      // Scoped by workspaceId; updateMany tolerates the row having been
      // deleted (disconnect) mid-refresh instead of throwing P2025.
      await this.prisma.googleCalendarConfig.updateMany({
        where: { workspaceId },
        data: {
          accessToken: this.encryptToken(next.accessToken),
          refreshToken: this.encryptToken(next.refreshToken),
          tokenExpiry: next.tokenExpiry,
        },
      });
    } catch (err) {
      // The token itself is valid even if persistence failed, so let this call
      // proceed rather than failing the booking; the next call refreshes
      // again. Never log token material.
      this.logger.error(
        `Failed to persist refreshed Google Calendar credentials for workspace ${workspaceId}: ${
          (err as Error).message
        }`,
      );
    }

    return next;
  }

  private isExpired(tokenExpiry: Date): boolean {
    return tokenExpiry.getTime() - EXPIRY_SKEW_MS <= Date.now();
  }

  /**
   * Tokens are stored as a JSON-serialized AES-256-GCM envelope. Rows written
   * before encryption landed hold plaintext, so those are read as-is and get
   * upgraded to ciphertext on the next refresh or reconnect.
   */
  private encryptToken(value: string): string {
    return JSON.stringify(this.encryption.encryptJson(value));
  }

  private decryptToken(value: string): string {
    if (!value.startsWith('{')) return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    if (!this.isEncryptedEnvelope(parsed)) return value;
    return this.encryption.decryptJson<string>(parsed);
  }

  private readCredentials(config: {
    accessToken: string;
    refreshToken: string;
    tokenExpiry: Date;
  }): CalendarCredentials {
    return {
      accessToken: this.decryptToken(config.accessToken),
      refreshToken: this.decryptToken(config.refreshToken),
      tokenExpiry: new Date(config.tokenExpiry),
    };
  }

  private isEncryptedEnvelope(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    return maybe.v === 1 && maybe.alg === 'aes-256-gcm';
  }
}
