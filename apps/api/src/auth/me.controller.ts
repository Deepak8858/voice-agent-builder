import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthService } from './supabase-auth.service';

@Controller('auth')
export class MeController {
  constructor(private readonly authService: SupabaseAuthService) {}

  @Get('me')
  async me(@Req() req: Request) {
    // Delegate to SupabaseAuthService — workspace provisioning and session
    // building are already handled there. We only need to pass the auth header.
    const sessionUser = await this.authService.getSessionUser(req);
    if (!sessionUser) {
      const authUserId = req.headers['x-user-id'] as string;
      return {
        id: authUserId ?? null,
        email: req.headers['x-user-email'] as string ?? '',
        name: null,
        active_workspace_id: null,
        active_workspace_name: null,
        active_workspace_role: 'viewer',
      };
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