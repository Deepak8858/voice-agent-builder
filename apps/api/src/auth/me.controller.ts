import { Controller, Get, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { UnauthorizedError } from '../common/errors';
import { EmailService } from '../email/email.service';
import { SupabaseAuthService } from './supabase-auth.service';

@Controller('auth')
export class MeController {
  private readonly logger = new Logger(MeController.name);

  constructor(
    private readonly authService: SupabaseAuthService,
    private readonly email: EmailService,
  ) {}

  @Get('me')
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
