import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { env } from '../config/env';
import { UnauthorizedError } from '../common/errors';
import { IS_INTERNAL_ONLY_KEY } from '../common/decorators/internal-only.decorator';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { constantTimeEqual } from '../common/secure-compare';
import { SupabaseAuthService } from './supabase-auth.service';

/**
 * Trust boundary for the API. The Next.js frontend is the only legitimate
 * caller. This guard verifies the internal key, then derives req.user from
 * the Supabase bearer token. It intentionally does not trust forwarded user
 * metadata headers because Supabase raw_user_meta_data is user-editable.
 *
 *   x-internal-key   shared secret (env.INTERNAL_API_KEY)
 *   authorization    Supabase access token, when acting as a user
 *
 * Public routes (health, metrics, provider webhooks) opt out via @Public().
 * Routes that our own runtime calls and a user must never reach, even through
 * the frontend proxy, declare @InternalOnly().
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authService: SupabaseAuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
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

    if (typeof provided !== 'string' || !constantTimeEqual(provided, expected)) {
      throw new UnauthorizedError();
    }

    const authorization = headerString(req, 'authorization');
    if (!authorization) {
      if (headerString(req, 'x-user-id') || headerString(req, 'x-app-user-id')) {
        this.logger.warn('Rejecting user context without a Supabase bearer token.');
        throw new UnauthorizedError();
      }
      // No user context: allow internal platform calls, but workspace routes
      // will still fail in WorkspaceGuard because req.user is absent.
      return true;
    }

    // Holding the internal key is not enough to reach an @InternalOnly() route,
    // because the frontend proxy holds it too and forwards whatever path the
    // browser asks for. A request carrying user context is by definition not
    // our runtime, so it is refused before the handler can act on a body it
    // would otherwise trust as machine-issued.
    if (this.isInternalOnly(ctx)) {
      this.logger.warn(
        `Rejecting user-authenticated request to internal-only route ${req.method} ${req.path}.`,
      );
      throw new UnauthorizedError();
    }

    const sessionUser = await this.authService.getSessionUser(req);
    if (!sessionUser?.id || !isValidUUID(sessionUser.id)) {
      this.logger.warn('Supabase bearer token did not resolve to a valid app user.');
      throw new UnauthorizedError();
    }

    req.user = sessionUser;

    return true;
  }

  /** True when the handler or its controller declares @InternalOnly(). */
  private isInternalOnly(ctx: ExecutionContext): boolean {
    return this.reflector.getAllAndOverride<boolean>(IS_INTERNAL_ONLY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) === true;
  }
}

function headerString(req: Request, key: string): string | null {
  const v = req.headers[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return null;
}

function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}
