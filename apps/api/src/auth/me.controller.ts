import { Controller, Get, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { UnauthorizedError } from '../common/errors';
import { EmailService } from '../email/email.service';
import { SkipRateLimit } from '../common/rate-limit.guard';
import { SupabaseAuthService } from './supabase-auth.service';

@Controller('auth')
export class MeController {
  private readonly logger = new Logger(MeController.name);

  constructor(
    private readonly authService: SupabaseAuthService,
    private readonly email: EmailService,
  ) {}

  // Session bootstrap, not a tenant action: every authenticated page (dashboard
  // shell, billing banner, checkout preflight) reads this on load, so it is by
  // far the most-called route. The global limiter runs after InternalAuthGuard
  // has already resolved req.user, so this handler only echoes fields that are
  // in hand — yet each call still spends a token from the per-user 100/60s
  // budget. An active user, or a checkout that fires several requests at once,
  // then trips the limit on the identity lookup itself and the 429 blocks
  // checkout. Exempt the read; mutations keep their limits.
  @Get('me')
  @SkipRateLimit()
  async me(@Req() req: Request) {
    // Delegate to SupabaseAuthService — workspace provisioning and session
    // building are already handled there. We only need to pass the auth header.
    const sessionUser = (req as Request & { user?: SessionUser }).user
      ?? await this.authService.getSessionUser(req);
    if (!sessionUser) {
      throw new UnauthorizedError();
    }
    return {
      id: sessionUser.id,
      email: sessionUser.email,
      name: sessionUser.name,
      active_workspace_id: sessionUser.active_workspace_id,
      active_workspace_name: sessionUser.active_workspace_name,
      active_workspace_role: sessionUser.active_workspace_role,
    };
  }

  @Post('me/welcome-email')
  async welcomeEmail(@Req() req: Request) {
    const sessionUser = (req as Request & { user?: SessionUser }).user
      ?? await this.authService.getSessionUser(req);
    if (!sessionUser) {
      throw new UnauthorizedError();
    }
    // Self-mail only: the recipient is always the session user's own address.
    void this.email
      .sendWelcomeEmail({ to: sessionUser.email, name: sessionUser.name })
      .catch((err: Error) =>
        this.logger.warn(`[welcome-email] delivery failed: ${err.message}`),
      );
    return { queued: true };
  }
}
