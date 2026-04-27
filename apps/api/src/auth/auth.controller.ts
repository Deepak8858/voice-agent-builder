import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UnauthorizedError } from '../common/errors';
import { AuthService } from './auth.service';

const SignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).optional(),
  name: z.string().optional(),
  organization_name: z.string().optional(),
});
type SignupDto = z.infer<typeof SignupSchema>;

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().optional(),
});
type LoginDto = z.infer<typeof LoginSchema>;

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('signup')
  async signup(
    @Body(new ZodValidationPipe(SignupSchema)) dto: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.signup(dto, res);
  }

  @Post('login')
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(dto, res);
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
