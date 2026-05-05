import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { UnauthorizedError } from '../common/errors';
import { AuthService } from './auth.service';

/**
 * Auth controller - signup/login delegated to Clerk UI.
 * Sign-up/sign-in via POST /auth/signup and /auth/login are disabled.
 * Only /auth/me and /auth/logout are functional.
 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('signup')
  async signup() {
    throw new UnauthorizedError(
      'Sign-up happens via Clerk UI. Use the Sign-up button.',
    );
  }

  @Post('login')
  async login() {
    throw new UnauthorizedError(
      'Sign-in happens via Clerk UI. Use the Sign-in button.',
    );
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req, res);
    return { ok: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const user = await this.auth.getSessionUser(req);
    if (!user) throw new UnauthorizedError();
    return user;
  }
}
