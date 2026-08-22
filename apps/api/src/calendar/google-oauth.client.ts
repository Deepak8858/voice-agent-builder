import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { AppError } from '../common/errors';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Hard ceiling on token-endpoint requests. A stalled Google endpoint must
 * not keep OAuth requests pending and consume API request capacity.
 */
export const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;

/**
 * Structured marker set on the AppError details when Google reports
 * `invalid_grant` (revoked/expired refresh token). Callers must test this
 * field — never the human-readable message — to detect a reauth condition.
 */
export const GOOGLE_REAUTH_DETAILS_KEY = 'googleReauthRequired';

/** Read Google's machine-readable `error` field without logging the body. */
async function readGoogleErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === 'string' ? payload.error : null;
  } catch {
    return null;
  }
}

export interface RefreshedGoogleToken {
  accessToken: string;
  /** Absolute expiry, already converted from Google's relative `expires_in`. */
  expiresAt: Date;
  /** Google only returns a new refresh token on rotation; usually absent. */
  refreshToken?: string;
}

export interface ExchangedGoogleToken {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, already converted from Google's relative `expires_in`. */
  expiresAt: Date;
  /** Scopes Google actually granted, which may differ from those requested. */
  scopes: string[];
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
   * Build the Google consent URL for the authorization-code flow.
   *
   * `access_type=offline` + `prompt=consent` force Google to return a refresh
   * token on every connect, so a re-connect always yields a full token set.
   */
  getAuthUrl(scopes: string[], state: string, redirectUri: string): string {
    const clientId = env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google OAuth client credentials are not configured.',
        400,
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for a full token set.
   *
   * Throws AppError rather than returning a partial result, so a failed
   * exchange can never persist a half-connected state.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<ExchangedGoogleToken> {
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
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }).toString(),
        signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure or timeout. Never include the request body in the log.
      this.logger.error(`Google code exchange request failed: ${(err as Error).message}`);
      throw new AppError('CRM_NOT_CONFIGURED', 'Failed to exchange the Google authorization code.', 400);
    }

    if (!response.ok) {
      // Log Google's machine-readable error code only — never the body,
      // which can echo request material.
      const errorCode = await readGoogleErrorCode(response);
      this.logger.error(
        `Google code exchange rejected with status ${response.status}${
          errorCode ? ` (${errorCode})` : ''
        }`,
      );
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google rejected the authorization code — please try connecting again.',
        400,
      );
    }

    let payload: {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // A proxy can return non-JSON on a 200; surface the same AppError as
      // any other malformed token response instead of a raw SyntaxError.
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google token response was malformed or did not include a refresh token.',
        400,
      );
    }

    const accessToken = payload.access_token;
    const refreshToken = payload.refresh_token;
    if (
      typeof accessToken !== 'string' || accessToken.length === 0 ||
      typeof refreshToken !== 'string' || refreshToken.length === 0
    ) {
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google token response was malformed or did not include a refresh token.',
        400,
      );
    }

    const expiresInSeconds =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600;

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    };
  }

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
        signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure or timeout. Never include the request body in the log.
      this.logger.error(`Google token refresh request failed: ${(err as Error).message}`);
      throw new AppError('CRM_NOT_CONFIGURED', 'Failed to refresh Google token.', 400);
    }

    if (!response.ok) {
      // Google returns 400 `invalid_grant` when the refresh token was revoked
      // or expired; only that code is unrecoverable and requires a re-connect.
      // Anything else (429 rate limit, 5xx outage) is transient and must not
      // flip the connection into needs_reauth. Callers detect the reauth
      // condition via the structured details flag, not the message text.
      const errorCode = await readGoogleErrorCode(response);
      this.logger.error(
        `Google token refresh rejected with status ${response.status}${
          errorCode ? ` (${errorCode})` : ''
        }`,
      );
      if (errorCode !== 'invalid_grant') {
        throw new AppError(
          'CRM_NOT_CONFIGURED',
          'Google could not refresh the token — please try again shortly.',
          400,
        );
      }
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google authorization is no longer valid — re-connect required.',
        400,
        { [GOOGLE_REAUTH_DETAILS_KEY]: true },
      );
    }

    let payload: {
      access_token?: unknown;
      expires_in?: unknown;
      refresh_token?: unknown;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google token response was malformed.',
        400,
      );
    }

    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'Google token response was malformed.',
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
