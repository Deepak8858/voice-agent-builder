import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { UnauthorizedError } from '../common/errors';
import { SupabaseAuthService } from './supabase-auth.service';

@Controller('auth')
export class MeController {
  constructor(private readonly authService: SupabaseAuthService) {}

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
}
