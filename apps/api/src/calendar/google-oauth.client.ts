import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { AppError } from '../common/errors';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface RefreshedGoogleToken {
  accessToken: string;
  /** Absolute expiry, already converted from Google's relative `expires_in`. */
  expiresAt: Date;
  /** Google only returns a new refresh token on rotation; usually absent. */
  refreshToken?: string;
}

/**
 * Thin wrapper around Google's OAuth token endpoint.
 *
 * Kept separate from CalendarService so token exchange can be tested and
 * mocked without standing up Prisma, and so no other module needs to know
 * how the client credentials are sourced.
 */
@Injectable()
export class GoogleOAuthClient {
  private readonly logger = new Logger(GoogleOAuthClient.name);

  /**
   * Exchange a refresh token for a fresh access token.
   *
   * Throws AppError rather than returning a partial result: callers must not
   * be able to accidentally proceed with an expired token.
   */
  async refreshAccessToken(refreshToken: string): Promise<RefreshedGoogleToken> {
    const clientId = env.GOOGLE_CLIENT_ID;
    const clientSecret = env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google OAuth client credentials are not configured.',
        400,
      );
    }

    let response: Response;
    try {
      response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });
    } catch (err) {
      // Network-level failure. Never include the request body in the log.
      this.logger.error(`Google token refresh request failed: ${(err as Error).message}`);
      throw new AppError('CRM_NOT_CONFIGURED', 'Failed to refresh Google Calendar token.', 400);
    }

    if (!response.ok) {
      // Google returns 400 `invalid_grant` when the refresh token was revoked
      // or expired; that is unrecoverable and requires a re-connect.
      this.logger.error(`Google token refresh rejected with status ${response.status}`);
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google Calendar authorization is no longer valid — re-connect required.',
        400,
      );
    }

    const payload = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
      refresh_token?: unknown;
    };

    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google Calendar token response was malformed.',
        400,
      );
    }

    const expiresInSeconds =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600;

    return {
      accessToken,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      ...(typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
        ? { refreshToken: payload.refresh_token }
        : {}),
    };
  }
}
