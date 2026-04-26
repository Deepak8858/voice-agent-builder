import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthorizedError } from '../common/errors';
import { AuthService, type LoginInput, type SignupInput } from './auth.service';

const COOKIE_NAME = 'vf_session';
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * MOCK ONLY \u2014 NEVER use in production.
 * Cookie value is just the user id; no signing, no password hashing. Good
 * enough for Phase 0/1 demo; replaced by Clerk in Phase 3+.
 */
@Injectable()
export class MockAuthService extends AuthService {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async signup(input: SignupInput, res: Response): Promise<SessionUser> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return this.login({ email }, res);
    }

    const orgName = input.organization_name ?? `${input.name ?? 'My'} Workspace`;
    const orgSlug = slugify(orgName) + '-' + Math.random().toString(36).slice(2, 6);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name: input.name ?? email.split('@')[0] },
      });
      const org = await tx.organization.create({
        data: { name: orgName, slug: orgSlug, ownerUserId: user.id },
      });
      const ws = await tx.workspace.create({
        data: {
          organizationId: org.id,
          name: 'Demo Workspace',
          slug: 'demo',
          type: 'direct',
        },
      });
      await tx.membership.create({
        data: { userId: user.id, workspaceId: ws.id, role: 'owner' },
      });
      return { user, ws };
    });

    this.setSessionCookie(res, result.user.id);
    return {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      active_workspace_id: result.ws.id,
      active_workspace_name: result.ws.name,
      active_workspace_role: 'owner',
    };
  }

  async login(input: LoginInput, res: Response): Promise<SessionUser> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedError('Invalid credentials.');
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new UnauthorizedError('No workspace available for this user.');
    this.setSessionCookie(res, user.id);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      active_workspace_id: membership.workspaceId,
      active_workspace_name: membership.workspace.name,
      active_workspace_role: membership.role as SessionUser['active_workspace_role'],
    };
  }

  async logout(res: Response): Promise<void> {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax' });
  }

  async getSessionUser(req: Request): Promise<SessionUser | null> {
    const userId = req.cookies?.[COOKIE_NAME];
    if (!userId || typeof userId !== 'string') return null;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    const membership = await this.prisma.membership.findFirst({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      active_workspace_id: membership.workspaceId,
      active_workspace_name: membership.workspace.name,
      active_workspace_role: membership.role as SessionUser['active_workspace_role'],
    };
  }

  private setSessionCookie(res: Response, userId: string): void {
    res.cookie(COOKIE_NAME, userId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';
}
