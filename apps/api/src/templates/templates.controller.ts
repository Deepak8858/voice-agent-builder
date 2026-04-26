import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { UnauthorizedError } from '../common/errors';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly service: TemplatesService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const user = await this.auth.getSessionUser(req);
    if (!user) throw new UnauthorizedError();
    return { items: await this.service.list() };
  }

  @Get(':templateSlug')
  async get(@Req() req: Request, @Param('templateSlug') slug: string) {
    const user = await this.auth.getSessionUser(req);
    if (!user) throw new UnauthorizedError();
    return this.service.getBySlug(slug);
  }
}
