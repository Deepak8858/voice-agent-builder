import { Injectable, Logger } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request, Response } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthorizedError } from '../common/errors';
import { AuthService, type LoginInput, type SignupInput } from './auth.service';
import { CacheService } from '../cache/cache.service';

const SESSION_USER_TTL = 300;
const SESSION_WORKSPACE_TTL = 300;

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
  private readonly supabase: SupabaseClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {
    super();
    this.supabase = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;
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

  async logout(_req: Request, _res: Response): Promise<void> {
    // Supabase handles token invalidation via JWT expiration.
  }

  async getSessionUser(req: Request): Promise<SessionUser | null> {
    if (!env.SUPABASE_JWT_SECRET) return null;
    const token = this.extractBearerToken(req);
    if (!token) return null;

    let claims: SupabaseJWTPayload;
    try {
      claims = jwt.verify(token, env.SUPABASE_JWT_SECRET, {
        algorithms: ['HS256'],
      }) as SupabaseJWTPayload;
    } catch (err) {
      this.logger.debug(`[supabase] token verify failed: ${(err as Error).message}`);
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
      ?? await this.provisionPersonalWorkspace(user.id, supabaseUserId);

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
      const user = await this.prisma.user.upsert({
        where: { authUserId },
        create: { authUserId, email, name },
        update: { email, name },
      });
      await this.provisionPersonalWorkspace(user.id, supabaseUserId);
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
    const orgSlug = `user-${supabaseUserId.slice(0, 8)}`;
    const organization = await this.prisma.organization.upsert({
      where: { slug: orgSlug },
      create: {
        slug: orgSlug,
        name: 'Personal',
        ownerUserId: userId,
      },
      update: {},
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

    return this.prisma.membership.upsert({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      create: { userId, workspaceId: workspace.id, role: 'owner' },
      update: {},
      include: { workspace: true },
    });
  }

  private extractBearerToken(req: Request): string | null {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    return token;
  }
}