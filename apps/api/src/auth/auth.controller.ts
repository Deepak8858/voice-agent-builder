import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { Public } from '../common/decorators/public.decorator';
import type { LoginInput, SignupInput } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  @Public()
  async signup(@Body() input: SignupInput, @Res() res: Response) {
    const user = await this.authService.signup(input, res);
    return res.json({ success: true, data: user });
  }

  @Post('login')
  @Public()
  async login(@Body() input: LoginInput, @Res() res: Response) {
    const user = await this.authService.login(input, res);
    return res.json({ success: true, data: user });
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    await this.authService.logout(req, res);
    return res.json({ success: true });
  }
}