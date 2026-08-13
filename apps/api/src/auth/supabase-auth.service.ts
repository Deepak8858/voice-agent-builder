import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthorizedError } from '../common/errors';
import { AuthService, type LoginInput, type SignupInput } from './auth.service';
import { CacheService } from '../cache/cache.service';
import { PostHogService } from '../posthog/posthog.service';

const SESSION_USER_TTL = 300;
const SESSION_WORKSPACE_TTL = 300;
const TOKEN_CLAIMS_TTL = 60;

interface SupabaseAuthUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

interface SupabaseJWTPayload {
  sub: string;
  email?: string;
  aud: string;
  role?: string;
  exp: number;
  user_metadata?: {
    full_name?: string;
    name?: string;
    avatar_url?: string;
  };
  app_metadata?: {
    provider?: string;
    providers?: string[];
  };
}

@Injectable()
export class SupabaseAuthService extends AuthService {
  private readonly logger = new Logger(SupabaseAuthService.name);
  private readonly supabaseUrl: string | null;
  private readonly supabaseServiceRoleKey: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Optional() private readonly posthog?: PostHogService,
  ) {
    super();
    const supabaseUrl = env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    this.supabaseUrl = supabaseUrl ?? null;
    this.supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? null;
  }

  async signup(_input: SignupInput, _res: Response): Promise<SessionUser> {
    throw new UnauthorizedError(
      'Sign-up happens via Supabase. Use the Sign-up page in the app.',
    );
  }

  async login(_input: LoginInput, _res: Response): Promise<SessionUser> {
    throw new UnauthorizedError(
      'Sign-in happens via Supabase. Use the Sign-in page in the app.',
    );
  }

  async logout(req: Request, _res: Response): Promise<void> {
    const token = this.extractBearerToken(req);
    if (!token || !this.supabaseUrl || !this.supabaseServiceRoleKey) return;
    try {
      await fetch(`${this.supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: this.supabaseServiceRoleKey,
          authorization: `Bearer ${token}`,
        },
      });
    } catch {
      // Best-effort remote sign-out; local cookies are cleared by the web app.
    }
  }

  async getSessionUser(req: Request): Promise<SessionUser | null> {
    const token = this.extractBearerToken(req);
    if (!token) return null;

    const claims = await this.resolveClaims(token);
    if (!claims) {
      return null;
    }

    const supabaseUserId = claims.sub;
    if (!supabaseUserId) return null;

    const userKey = `session:user:${supabaseUserId}`;
    const cached = await this.cache.get<SessionUser>(userKey);
    if (cached) {
      req.res?.setHeader('X-Cache-Hit', 'true');
      return cached;
    }
    req.res?.setHeader('X-Cache-Hit', 'false');

    try {
      const sessionUser = await this.buildSessionUser(supabaseUserId, claims);
      if (sessionUser) {
        await this.cache.set(userKey, sessionUser, SESSION_USER_TTL);
      }
      return sessionUser;
    } catch (err) {
      this.logger.warn(`[supabase] session build failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async resolveClaims(token: string): Promise<SupabaseJWTPayload | null> {
    if (env.SUPABASE_JWT_SECRET) {
      try {
        return jwt.verify(token, env.SUPABASE_JWT_SECRET, {
          algorithms: ['HS256'],
          audience: 'authenticated',
          ...(this.supabaseUrl
            ? { issuer: `${this.supabaseUrl.replace(/\/$/, '')}/auth/v1` }
            : {}),
        }) as SupabaseJWTPayload;
      } catch (err) {
        this.logger.debug(`[supabase] local token verify failed: ${(err as Error).message}`);
      }
    }

    const claimsKey = this.claimsCacheKey(token);
    const cachedClaims = await this.cache.get<SupabaseJWTPayload>(claimsKey);
    if (cachedClaims && this.claimsAreFresh(cachedClaims)) {
      return cachedClaims;
    }

    const user = await this.getSupabaseUser(token);
    if (!user) {
      return null;
    }

    const claims = this.claimsFromSupabaseUser(user, token);
    await this.cache.set(claimsKey, claims, this.claimsTtlSeconds(claims));
    return claims;
  }

  private async getSupabaseUser(token: string): Promise<SupabaseAuthUser | null> {
    if (!this.supabaseUrl || !this.supabaseServiceRoleKey) return null;

    const res = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: this.supabaseServiceRoleKey,
        authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      this.logger.debug(`[supabase] token introspection failed: HTTP ${res.status}`);
      return null;
    }

    return (await res.json()) as SupabaseAuthUser;
  }

  private claimsFromSupabaseUser(user: SupabaseAuthUser, token: string): SupabaseJWTPayload {
    const decoded = jwt.decode(token) as Partial<SupabaseJWTPayload> | null;
    const exp =
      typeof decoded?.exp === 'number'
        ? decoded.exp
        : Math.floor(Date.now() / 1000) + TOKEN_CLAIMS_TTL;
    const aud = typeof decoded?.aud === 'string' ? decoded.aud : 'authenticated';

    return {
      sub: user.id,
      email: user.email,
      aud,
      ...(typeof decoded?.role === 'string' ? { role: decoded.role } : {}),
      user_metadata: {
        full_name: asString(user.user_metadata?.full_name),
        name: asString(user.user_metadata?.name),
        avatar_url: asString(user.user_metadata?.avatar_url),
      },
      app_metadata: {
        provider: asString(user.app_metadata?.provider),
        providers: Array.isArray(user.app_metadata?.providers)
          ? user.app_metadata.providers.filter((provider): provider is string => typeof provider === 'string')
          : undefined,
      },
      exp,
    };
  }

  private claimsCacheKey(token: string): string {
    return `session:claims:${this.tokenHash(token)}`;
  }

  private tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private claimsAreFresh(claims: SupabaseJWTPayload): boolean {
    return claims.exp > Math.floor(Date.now() / 1000);
  }

  private claimsTtlSeconds(claims: SupabaseJWTPayload): number {
    const secondsUntilExpiry = claims.exp - Math.floor(Date.now() / 1000);
    if (secondsUntilExpiry <= 0) return 1;
    return Math.max(1, Math.min(TOKEN_CLAIMS_TTL, secondsUntilExpiry));
  }

  private async buildSessionUser(
    supabaseUserId: string,
    claims: SupabaseJWTPayload,
  ): Promise<SessionUser | null> {
    const authUserId = supabaseUserId;
    const user = await this.findOrProvisionUser(authUserId, supabaseUserId, claims);

    const workspaceKey = `session:workspace:${user.id}`;
    const cachedWorkspace = await this.cache.get<SessionUser>(workspaceKey);
    if (cachedWorkspace) return cachedWorkspace;

    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    const activeMembership = membership
      ?? (await this.provisionPersonalWorkspace(user.id, supabaseUserId)).membership;

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      active_workspace_id: activeMembership.workspace.id,
      active_workspace_name: activeMembership.workspace.name,
      active_workspace_role: activeMembership.role as SessionUser['active_workspace_role'],
    };

    await this.cache.set(workspaceKey, sessionUser, SESSION_WORKSPACE_TTL);
    return sessionUser;
  }

  private async findOrProvisionUser(
    authUserId: string,
    supabaseUserId: string,
    claims: SupabaseJWTPayload,
  ) {
    const existing = await this.prisma.user.findUnique({ where: { authUserId } });
    if (existing) return existing;

    const email = claims.email ?? `${supabaseUserId}@supabase.invalid`;
    const name = claims.user_metadata?.full_name ?? claims.user_metadata?.name ?? null;

    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      if (!byEmail.authUserId || byEmail.authUserId === authUserId) {
        const user = await this.prisma.user.update({
          where: { id: byEmail.id },
          data: { authUserId, name },
        });
        await this.provisionPersonalWorkspace(user.id, supabaseUserId);
        return user;
      }
      return byEmail;
    }

    try {
      // No user existed by auth ID or email, so this is a genuine first sign-up.
      const user = await this.prisma.user.upsert({
        where: { authUserId },
        create: { authUserId, email, name },
        update: { email, name },
      });
      const provisioned = await this.provisionPersonalWorkspace(user.id, supabaseUserId);
      this.captureSignedUp(
        user.id,
        provisioned.membership.workspace.id,
        provisioned.membership.workspace.organizationId,
        provisioned.workspaceCreated,
      );
      return user;
    } catch (err: unknown) {
      const prismaErr = err as { code?: string };
      if (prismaErr.code === 'P2002') {
        const raced = await this.prisma.user.findUnique({ where: { authUserId } })
          ?? await this.prisma.user.findUnique({ where: { email } });
        if (raced) {
          if (!raced.authUserId || raced.authUserId === authUserId) {
            const updated = await this.prisma.user.update({
              where: { id: raced.id },
              data: { authUserId, name: name ?? raced.name },
            });
            await this.provisionPersonalWorkspace(updated.id, supabaseUserId);
            return updated;
          }
          await this.provisionPersonalWorkspace(raced.id, supabaseUserId);
          return raced;
        }
      }
      throw err;
    }
  }

  private async provisionPersonalWorkspace(userId: string, supabaseUserId: string) {
    // A truncated auth ID can collide and attach one user's workspace to
    // another organization. A bounded SHA-256 suffix is deterministic while
    // preserving the opaque source ID.
    const orgSlug = `user-${createHash('sha256').update(supabaseUserId).digest('hex').slice(0, 24)}`;

    // Slug migration: releases before the hash-based slug used
    // `user-${supabaseUserId.slice(0, 8)}`. An existing user whose membership
    // was lost would otherwise get a second organization and workspace here,
    // so look up the legacy organization (verified by owner) first.
    const legacySlug = `user-${supabaseUserId.slice(0, 8)}`;
    const legacyOrganization = await this.prisma.organization.findFirst({
      where: { slug: legacySlug, ownerUserId: userId },
    });

    const organization =
      legacyOrganization ??
      (await this.prisma.organization.upsert({
        where: { slug: orgSlug },
        create: {
          slug: orgSlug,
          name: 'Personal',
          ownerUserId: userId,
        },
        update: {},
      }));

    let workspace = await this.prisma.workspace.findFirst({
      where: { organizationId: organization.id },
      orderBy: { createdAt: 'asc' },
    });
    const workspaceCreated = !workspace;
    if (!workspace) {
      workspace = await this.prisma.workspace.create({
        data: {
          organizationId: organization.id,
          name: 'Demo Workspace',
          slug: 'demo',
          type: 'direct',
        },
      });
    }

    const membership = await this.prisma.membership.upsert({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      create: { userId, workspaceId: workspace.id, role: 'owner' },
      update: {},
      include: { workspace: true },
    });
    return { membership, workspaceCreated };
  }

  /**
   * Best-effort product analytics for first sign-up. The workspace is created
   * as part of provisioning, so both events are emitted from here where the
   * app user ID and the server-resolved organization ID are both known.
   */
  private captureSignedUp(
    userId: string,
    workspaceId: string,
    organizationId: string,
    workspaceCreated: boolean,
  ): void {
    if (!this.posthog) return;
    const context = { workspaceId, organizationId, userId };
    this.posthog.capture(
      { event: 'user_signed_up', properties: { workspace_id: workspaceId } },
      context,
    );
    if (workspaceCreated) {
      this.posthog.capture(
        { event: 'workspace_created', properties: { workspace_id: workspaceId } },
        context,
      );
    }
  }

  private extractBearerToken(req: Request): string | null {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    return token;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
