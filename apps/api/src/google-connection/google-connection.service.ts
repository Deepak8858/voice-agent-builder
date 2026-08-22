import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors';
import { env } from '../config/env';
import { safeFetch } from '../common/safe-fetch';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../security/encryption.service';
import { GOOGLE_REAUTH_DETAILS_KEY, GoogleOAuthClient } from '../calendar/google-oauth.client';
import { GOOGLE_TOOL_PRESETS, GOOGLE_WORKSPACE_SCOPES } from './google-tool-presets';
import { signOAuthState, verifyOAuthState } from './oauth-state';

/**
 * Refresh this long before the recorded expiry. Google access tokens are
 * valid for an hour; refreshing slightly early avoids a race where the token
 * expires between our check and Google receiving the API call.
 */
const EXPIRY_SKEW_MS = 60_000;

/** Google's token revocation endpoint (accepts access or refresh tokens). */
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** Ceiling on the best-effort revoke call so disconnect stays fast. */
const GOOGLE_REVOKE_TIMEOUT_MS = 5_000;

/** Connection lifecycle states persisted on GoogleOAuthConnection.status. */
export const GOOGLE_CONNECTION_STATUS = {
  CONNECTED: 'connected',
  NEEDS_REAUTH: 'needs_reauth',
  INVALID: 'invalid',
} as const;

/** Marker used by callers to distinguish a reauth condition from other failures. */
export const GOOGLE_REAUTH_REQUIRED_MESSAGE =
  'Google connection needs to be reconnected before this tool can run.';

interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
}

export interface GoogleConnectionStatus {
  connected: boolean;
  status: string | null;
  scopes: string[];
}

@Injectable()
export class GoogleConnectionService {
  private readonly logger = new Logger(GoogleConnectionService.name);

  /**
   * In-flight refreshes keyed by workspace. Two concurrent tool calls for the
   * same workspace must not both call Google and then race each other's
   * writes; the second caller awaits the first one's result.
   */
  private readonly inFlightRefreshes = new Map<string, Promise<GoogleCredentials>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly googleOAuth: GoogleOAuthClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * Build the consent URL plus a signed `state` bound to this workspace.
   * The state is the CSRF token: the callback refuses any state that was not
   * minted here for the same workspace.
   */
  getAuthorizeUrl(workspaceId: string): { url: string; state: string } {
    const redirectUri = this.requireRedirectUri();
    const state = signOAuthState(workspaceId, env.JWT_SECRET);
    const url = this.googleOAuth.getAuthUrl([...GOOGLE_WORKSPACE_SCOPES], state, redirectUri);
    return { url, state };
  }

  /**
   * Complete the authorization-code flow: validate state, exchange the code,
   * persist the encrypted token set with granted scopes, and provision the
   * workspace-wide Google tools.
   */
  async completeOAuthCallback(args: {
    workspaceId: string;
    code: string;
    state: string;
    actorUserId?: string;
  }): Promise<GoogleConnectionStatus> {
    if (!verifyOAuthState(args.state, args.workspaceId, env.JWT_SECRET)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'OAuth state is invalid or expired — restart the Google connect flow.',
        400,
      );
    }

    const redirectUri = this.requireRedirectUri();
    const exchanged = await this.googleOAuth.exchangeCode(args.code, redirectUri);

    const organizationId = await this.prisma.organizationIdFor(args.workspaceId);
    const accessToken = this.encryptToken(exchanged.accessToken);
    const refreshToken = this.encryptToken(exchanged.refreshToken);
    const now = new Date();

    await this.prisma.googleOAuthConnection.upsert({
      where: { workspaceId: args.workspaceId },
      create: {
        workspaceId: args.workspaceId,
        organizationId,
        accessToken,
        refreshToken,
        tokenExpiry: exchanged.expiresAt,
        scopes: exchanged.scopes,
        status: GOOGLE_CONNECTION_STATUS.CONNECTED,
        lastVerifiedAt: now,
      },
      update: {
        accessToken,
        refreshToken,
        tokenExpiry: exchanged.expiresAt,
        scopes: exchanged.scopes,
        status: GOOGLE_CONNECTION_STATUS.CONNECTED,
        lastVerifiedAt: now,
      },
    });

    await this.provisionTools(args.workspaceId, organizationId, exchanged.scopes);

    await this.auditBestEffort({
      workspaceId: args.workspaceId,
      organizationId,
      actorUserId: args.actorUserId ?? null,
      action: 'google.connection.connected',
      resourceType: 'google_oauth_connection',
      metadata: {
        grantedScopes: exchanged.scopes,
        status: GOOGLE_CONNECTION_STATUS.CONNECTED,
      },
    });

    return {
      connected: true,
      status: GOOGLE_CONNECTION_STATUS.CONNECTED,
      scopes: exchanged.scopes,
    };
  }

  async getStatus(workspaceId: string): Promise<GoogleConnectionStatus> {
    const connection = await this.prisma.googleOAuthConnection.findUnique({
      where: { workspaceId },
      select: { status: true, scopes: true },
    });
    if (!connection) return { connected: false, status: null, scopes: [] };
    return {
      connected: connection.status === GOOGLE_CONNECTION_STATUS.CONNECTED,
      status: connection.status,
      scopes: readScopes(connection.scopes),
    };
  }

  /** Best-effort disconnect: revoke the token, remove the connection, disable tools. */
  async disconnect(workspaceId: string, actorUserId?: string): Promise<void> {
    this.inFlightRefreshes.delete(workspaceId);

    // Capture the granted scopes (for the audit trail) and the refresh token
    // (for revocation) before the row is deleted.
    const existing = await this.prisma.googleOAuthConnection
      .findUnique({ where: { workspaceId }, select: { refreshToken: true, scopes: true } })
      .catch(() => null);
    const grantedScopes = existing ? readScopes(existing.scopes) : [];

    if (existing) {
      await this.revokeTokenBestEffort(workspaceId, existing.refreshToken);
    }

    try {
      await this.prisma.googleOAuthConnection.delete({ where: { workspaceId } });
    } catch (err) {
      // Only "record not found" (P2025) is expected here — anything else is a
      // real failure that must surface rather than silently leaving the
      // connection (and its tokens) in place.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025')) {
        throw err;
      }
    }

    await this.prisma.integrationTool
      .updateMany({
        where: {
          workspaceId,
          agentId: null,
          name: { in: GOOGLE_TOOL_PRESETS.map((preset) => preset.name) },
        },
        data: { enabled: false },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `Failed to disable provisioned Google tools for workspace ${workspaceId}: ${
            (err as Error).message
          }`,
        );
      });

    await this.auditBestEffort({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: 'google.connection.disconnected',
      resourceType: 'google_oauth_connection',
      metadata: {
        grantedScopes,
        status: 'disconnected',
      },
    });
  }

  /**
   * Ask Google to revoke the grant so the tokens are dead server-side, not
   * just deleted locally. Failures are logged and swallowed: the local delete
   * is authoritative for our system.
   */
  private async revokeTokenBestEffort(workspaceId: string, storedToken: string): Promise<void> {
    let token: string;
    try {
      token = this.decryptToken(storedToken);
    } catch (err) {
      this.logger.warn(
        `Skipping Google token revocation for workspace ${workspaceId}: ${(err as Error).message}`,
      );
      return;
    }
    try {
      const response = await safeFetch(GOOGLE_REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        timeoutMs: GOOGLE_REVOKE_TIMEOUT_MS,
      });
      if (!response.ok) {
        this.logger.warn(
          `Google token revocation for workspace ${workspaceId} returned status ${response.status}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Google token revocation failed for workspace ${workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  /** Audit writes must never fail the user-facing operation they describe. */
  private async auditBestEffort(payload: Parameters<AuditService['log']>[0]): Promise<void> {
    try {
      await this.audit.log(payload);
    } catch (err) {
      this.logger.error(
        `Failed to write audit log for action ${payload.action}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Load a usable access token for this workspace, refreshing first if the
   * stored token is expired (or about to be). Always scoped by workspaceId,
   * so one tenant can never obtain another tenant's Google token.
   */
  async getUsableAccessToken(workspaceId: string): Promise<string> {
    const connection = await this.prisma.googleOAuthConnection.findUnique({
      where: { workspaceId },
    });
    if (!connection) {
      throw new AppError('INTEGRATION_NOT_CONNECTED', 'Google is not connected.', 400);
    }
    if (connection.status === GOOGLE_CONNECTION_STATUS.NEEDS_REAUTH) {
      throw new AppError('INTEGRATION_NOT_CONNECTED', GOOGLE_REAUTH_REQUIRED_MESSAGE, 400);
    }
    if (connection.status !== GOOGLE_CONNECTION_STATUS.CONNECTED) {
      // `invalid` or any future non-connected state: refuse rather than hand
      // out credentials from a connection that is not known to be healthy.
      throw new AppError(
        'INTEGRATION_NOT_CONNECTED',
        'Google connection is not in a connected state.',
        400,
      );
    }

    const credentials: GoogleCredentials = {
      accessToken: this.decryptToken(connection.accessToken),
      refreshToken: this.decryptToken(connection.refreshToken),
      tokenExpiry: new Date(connection.tokenExpiry),
    };
    if (!this.isExpired(credentials.tokenExpiry)) {
      return credentials.accessToken;
    }

    const refreshed = await this.refreshCredentials(workspaceId, credentials);
    return refreshed.accessToken;
  }

  /**
   * Refresh and persist. Concurrent callers for the same workspace share one
   * in-flight refresh so we issue a single token request and a single write.
   */
  private async refreshCredentials(
    workspaceId: string,
    current: GoogleCredentials,
  ): Promise<GoogleCredentials> {
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
    current: GoogleCredentials,
  ): Promise<GoogleCredentials> {
    let refreshed;
    try {
      refreshed = await this.googleOAuth.refreshAccessToken(current.refreshToken);
    } catch (err) {
      // The client marks revoked/expired refresh tokens (invalid_grant) with
      // a structured details flag. That state is unrecoverable without user
      // consent, so record it for the UI.
      if (err instanceof AppError && err.details?.[GOOGLE_REAUTH_DETAILS_KEY] === true) {
        await this.markNeedsReauth(workspaceId);
        throw new AppError('INTEGRATION_NOT_CONNECTED', GOOGLE_REAUTH_REQUIRED_MESSAGE, 400);
      }
      throw err;
    }

    const next: GoogleCredentials = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
      tokenExpiry: refreshed.expiresAt,
    };

    try {
      // Scoped by workspaceId; updateMany tolerates the row having been
      // deleted (disconnect) mid-refresh instead of throwing P2025.
      await this.prisma.googleOAuthConnection.updateMany({
        where: { workspaceId },
        data: {
          accessToken: this.encryptToken(next.accessToken),
          refreshToken: this.encryptToken(next.refreshToken),
          tokenExpiry: next.tokenExpiry,
          status: GOOGLE_CONNECTION_STATUS.CONNECTED,
          lastVerifiedAt: new Date(),
        },
      });
    } catch (err) {
      // The token itself is valid even if persistence failed, so let this
      // call proceed rather than failing the tool run; the next call
      // refreshes again. Never log token material.
      this.logger.error(
        `Failed to persist refreshed Google credentials for workspace ${workspaceId}: ${
          (err as Error).message
        }`,
      );
    }

    return next;
  }

  private async markNeedsReauth(workspaceId: string): Promise<void> {
    try {
      // updateMany tolerates a deleted row (disconnect racing the refresh).
      await this.prisma.googleOAuthConnection.updateMany({
        where: { workspaceId },
        data: { status: GOOGLE_CONNECTION_STATUS.NEEDS_REAUTH },
      });
    } catch (err) {
      this.logger.error(
        `Failed to mark Google connection needs_reauth for workspace ${workspaceId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * Upsert workspace-wide IntegrationTool rows for each granted capability.
   * Config never carries tokens; executors resolve the workspace connection
   * at call time.
   */
  private async provisionTools(
    workspaceId: string,
    organizationId: string,
    grantedScopes: string[],
  ): Promise<void> {
    const granted = new Set(grantedScopes);

    // A re-connect can narrow the grant. Tools provisioned under a previous,
    // broader consent must not stay enabled once their scope is gone.
    const ungranted = GOOGLE_TOOL_PRESETS.filter(
      (preset) => !granted.has(preset.requiredScope),
    ).map((preset) => preset.name);
    if (ungranted.length > 0) {
      try {
        await this.prisma.integrationTool.updateMany({
          where: { workspaceId, agentId: null, name: { in: ungranted } },
          data: { enabled: false },
        });
      } catch (err) {
        this.logger.error(
          `Failed to disable Google tools without granted scopes for workspace ${workspaceId}: ${
            (err as Error).message
          }`,
        );
      }
    }

    for (const preset of GOOGLE_TOOL_PRESETS) {
      if (!granted.has(preset.requiredScope)) continue;
      try {
        await this.prisma.integrationTool.upsert({
          where: { workspaceId_name: { workspaceId, name: preset.name } },
          create: {
            workspaceId,
            organizationId,
            agentId: null,
            name: preset.name,
            description: preset.description,
            toolType: preset.toolType,
            config: preset.config as Prisma.InputJsonValue,
            inputSchema: preset.inputSchema as unknown as Prisma.InputJsonValue,
            enabled: true,
          },
          update: {
            description: preset.description,
            toolType: preset.toolType,
            config: preset.config as Prisma.InputJsonValue,
            inputSchema: preset.inputSchema as unknown as Prisma.InputJsonValue,
            enabled: true,
            agentId: null,
          },
        });
      } catch (err) {
        // Provisioning is best-effort per tool: one failure must not undo the
        // connection or block the remaining tools.
        this.logger.error(
          `Failed to provision Google tool ${preset.name} for workspace ${workspaceId}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  private requireRedirectUri(): string {
    const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI;
    if (!redirectUri) {
      throw new AppError(
        'CRM_NOT_CONFIGURED',
        'GOOGLE_OAUTH_REDIRECT_URI is not configured.',
        400,
      );
    }
    return redirectUri;
  }

  private isExpired(tokenExpiry: Date): boolean {
    return tokenExpiry.getTime() - EXPIRY_SKEW_MS <= Date.now();
  }

  /**
   * Tokens are stored as a JSON-serialized AES-256-GCM envelope, matching the
   * GoogleCalendarConfig convention.
   */
  private encryptToken(value: string): string {
    return JSON.stringify(this.encryption.encryptJson(value));
  }

  private decryptToken(value: string): string {
    // This table has only ever stored AES-256-GCM envelopes, so anything else
    // is corruption — refuse rather than hand back the raw column value as if
    // it were a token.
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AppError(
        'INTEGRATION_NOT_CONNECTED',
        'Stored Google credentials are unreadable — re-connect required.',
        400,
      );
    }
    if (!isEncryptedEnvelope(parsed)) {
      throw new AppError(
        'INTEGRATION_NOT_CONNECTED',
        'Stored Google credentials are unreadable — re-connect required.',
        400,
      );
    }
    return this.encryption.decryptJson<string>(parsed);
  }
}

function isEncryptedEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Record<string, unknown>;
  return maybe.v === 1 && maybe.alg === 'aes-256-gcm';
}

function readScopes(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
