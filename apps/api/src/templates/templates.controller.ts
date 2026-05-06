import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { UnauthorizedError } from '../common/errors';
import type { SessionUser } from '@voiceforge/shared';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly service: TemplatesService) {}

  @Get()
  async list(@CurrentUser() user: SessionUser | undefined) {
    if (!user) throw new UnauthorizedError();
    return { items: await this.service.list() };
  }

  @Get(':templateSlug')
  async get(@Param('templateSlug') slug: string, @CurrentUser() user: SessionUser | undefined) {
    if (!user) throw new UnauthorizedError();
    return this.service.getBySlug(slug);
  }
}
