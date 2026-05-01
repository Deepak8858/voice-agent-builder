import { Injectable, Logger } from '@nestjs/common';
import { createClerkClient, verifyToken, type ClerkClient } from '@clerk/backend';
import type { Request, Response } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthorizedError } from '../common/errors';
import { AuthService, type LoginInput, type SignupInput } from './auth.service';
import { CacheService } from '../cache/cache.service';

const SESSION_USER_TTL = 300; // 5 minutes
const SESSION_WORKSPACE_TTL = 300; // 5 minutes

/**
 * Clerk-backed auth. The Next.js frontend includes the Clerk session token on
 * every API call as `Authorization: Bearer <token>`. We verify the token, then
 * lazily upsert our VoiceForge User / Organization / Workspace / Membership
 * rows so Clerk is the system of record for identity and we remain the system
 * of record for tenancy + agents.
 *
 * Sign-up and sign-in are NOT handled here — Clerk's hosted UI owns those.
 * The auth controller's POST /signup / /login endpoints are disabled under
 * Clerk auth; the frontend uses Clerk UI exclusively.
 */
@Injectable()
export class ClerkAuthService extends AuthService {
  private readonly logger = new Logger(ClerkAuthService.name);
  private readonly client: ClerkClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {
    super();
    this.client = env.CLERK_SECRET_KEY
      ? createClerkClient({ secretKey: env.CLERK_SECRET_KEY })
      : null;
    if (!this.client) {
      this.logger.warn(
        'CLERK_SECRET_KEY is not set. ClerkAuthService will reject every request. ' +
          'Provide Clerk keys.',
      );
    }
  }

  async signup(_input: SignupInput, _res: Response): Promise<SessionUser> {
    throw new UnauthorizedError(
      'Sign-up happens via the Clerk UI. Use the Sign-up button in the app.',
    );
  }

  async login(_input: LoginInput, _res: Response): Promise<SessionUser> {
    throw new UnauthorizedError(
      'Sign-in happens via the Clerk UI. Use the Sign-in button in the app.',
    );
  }

  async logout(req: Request, _res: Response): Promise<void> {
    // Re-verify the token to extract the Clerk user ID for cache invalidation.
    const token = this.extractBearerToken(req);
    if (token && env.CLERK_SECRET_KEY) {
      try {
        const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
        const clerkUserId = claims.sub;
        if (clerkUserId) {
          await Promise.all([
            this.cache.del(`session:user:${clerkUserId}`),
            this.cache.del(`session:workspace:user:${clerkUserId}`),
          ]);
        }
      } catch {
        // Token already expired or invalid — nothing to invalidate.
      }
    }
  }

  async getSessionUser(req: Request): Promise<SessionUser | null> {
    if (!this.client || !env.CLERK_SECRET_KEY) return null;
    const token = this.extractBearerToken(req);
    if (!token) return null;

    let claims: Awaited<ReturnType<typeof verifyToken>>;
    try {
      claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    } catch (err) {
      this.logger.debug(`[clerk] token verify failed: ${(err as Error).message}`);
      return null;
    }

    const clerkUserId = claims.sub;
    if (!clerkUserId) return null;

    // Cache the full SessionUser result keyed by userId.
    const userKey = `session:user:${clerkUserId}`;
    const cached = await this.cache.get<SessionUser>(userKey);
    if (cached) {
      req.res?.setHeader('X-Cache-Hit', 'true');
      return cached;
    }
    req.res?.setHeader('X-Cache-Hit', 'false');

    try {
      const sessionUser = await this.buildSessionUser(clerkUserId, claims.org_id ?? null);
      if (sessionUser) {
        await this.cache.set(userKey, sessionUser, SESSION_USER_TTL);
      }
      return sessionUser;
    } catch (err) {
      this.logger.warn(`[clerk] session build failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async buildSessionUser(clerkUserId: string, clerkOrgId: string | null): Promise<SessionUser | null> {
    // Use raw Clerk ID consistently (webhooks also use raw ID)
    const externalAuthId = clerkUserId;
    const existing = await this.prisma.user.findUnique({ where: { externalAuthId } });
    const user = existing ?? (await this.provisionUser(externalAuthId, clerkUserId, clerkOrgId));

    // Also cache workspace lookup by workspaceId for fast workspace-scoped requests.
    const workspaceKey = `session:workspace:${user.id}`;
    const cachedWorkspace = await this.cache.get<SessionUser>(workspaceKey);
    if (cachedWorkspace) return cachedWorkspace;

    const membership = clerkOrgId
      ? await this.prisma.membership.findFirst({
          where: {
            userId: user.id,
            workspace: { organization: { clerkOrgId } },
          },
          include: { workspace: true },
          orderBy: { createdAt: 'asc' },
        })
      : await this.prisma.membership.findFirst({
          where: { userId: user.id },
          include: { workspace: true },
          orderBy: { createdAt: 'asc' },
        });

    const activeMembership = membership ?? (await this.provisionOrgWorkspace(user.id, clerkOrgId));

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      active_workspace_id: activeMembership.workspace.id,
      active_workspace_name: activeMembership.workspace.name,
      active_workspace_role: activeMembership.role as SessionUser['active_workspace_role'],
    };

    // Cache workspace lookup (same object, different key) so workspace-scoped requests can also hit cache.
    await this.cache.set(workspaceKey, sessionUser, SESSION_WORKSPACE_TTL);
    return sessionUser;
  }

  // ------------------------------------------------------------------------
  // Provisioning helpers
  // ------------------------------------------------------------------------

  private async provisionUser(
    externalAuthId: string,
    clerkUserId: string,
    clerkOrgId: string | null,
  ) {
    const clerkUser = await this.client!.users.getUser(clerkUserId);
    const email = clerkUser.emailAddresses[0]?.emailAddress ?? `${clerkUserId}@clerk.invalid`;
    const name =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ||
      clerkUser.username ||
      null;

    const user = await this.prisma.user.upsert({
      where: { externalAuthId },
      create: { externalAuthId, email, name },
      update: { email, name },
    });

    await this.provisionOrgWorkspace(user.id, clerkOrgId);
    return user;
  }

  private async provisionOrgWorkspace(userId: string, clerkOrgId: string | null) {
    const orgSlug = clerkOrgId
      ? this.orgSlug(clerkOrgId)
      : `personal-${userId.slice(0, 8)}`;
    const orgName = await this.resolveOrgName(clerkOrgId, orgSlug);

    const organization = await this.prisma.organization.upsert({
      where: { slug: orgSlug },
      create: { slug: orgSlug, name: orgName, ownerUserId: userId },
      update: { name: orgName },
    });

    let workspace = await this.prisma.workspace.findFirst({
      where: { organizationId: organization.id },
      orderBy: { createdAt: 'asc' },
    });
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
    return membership;
  }

  private async resolveOrgName(clerkOrgId: string | null, fallback: string): Promise<string> {
    if (!clerkOrgId || !this.client) return fallback;
    try {
      const org = await this.client.organizations.getOrganization({
        organizationId: clerkOrgId,
      });
      return org.name ?? fallback;
    } catch {
      return fallback;
    }
  }

  private orgSlug(clerkOrgId: string): string {
    return `clerk-${clerkOrgId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 32)}`;
  }

  private extractBearerToken(req: Request): string | null {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    return token;
  }
}
