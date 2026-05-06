import { Controller, Get, Inject, Param } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { TemplatesService } from './templates.service';

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly service: TemplatesService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  async list() {
    return { items: await this.service.list() };
  }

  @Get(':templateSlug')
  async get(@Param('templateSlug') slug: string) {
    return this.service.getBySlug(slug);
  }
}
