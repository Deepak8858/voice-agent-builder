import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { env } from '../config/env';
import { UnauthorizedError } from '../common/errors';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';

/**
 * Trust boundary for the API. The Next.js frontend is the only legitimate
 * caller; it verifies the Supabase session, then forwards the request with:
 *
 *   x-internal-key   shared secret (env.INTERNAL_API_KEY)
 *   x-user-id        auth.users.id (uuid)
 *   x-app-user-id    public.users.id (uuid)
 *   x-org-id         active organization id (uuid, optional)
 *   x-org-role       caller's role in the active workspace (optional)
 *   x-user-email     caller email (optional, for logs)
 *   x-workspace-id   active workspace id (optional)
 *   x-workspace-name active workspace name (optional)
 *
 * Public routes (health, metrics, provider webhooks) opt out via @Public().
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const provided = req.headers['x-internal-key'];
    const expected = env.INTERNAL_API_KEY;

    if (!expected) {
      this.logger.error('INTERNAL_API_KEY is not configured. Refusing all requests.');
      throw new UnauthorizedError();
    }

    if (typeof provided !== 'string' || provided !== expected) {
      throw new UnauthorizedError();
    }

    const appUserId = headerString(req, 'x-app-user-id');
    if (!appUserId) {
      // No user context — caller is the platform itself; allow but with no user.
      return true;
    }

    const role = (headerString(req, 'x-org-role') ?? 'viewer') as SessionUser['active_workspace_role'];

    req.user = {
      id: appUserId,
      email: headerString(req, 'x-user-email') ?? '',
      name: null,
      active_workspace_id: headerString(req, 'x-workspace-id') ?? null,
      active_workspace_name: headerString(req, 'x-workspace-name') ?? null,
      active_workspace_role: role,
    };

    return true;
  }
}

function headerString(req: Request, key: string): string | null {
  const v = req.headers[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return null;
}
