import { Controller, Post, UseGuards } from '@nestjs/common';
import { RetentionService } from './retention.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';

@Controller('admin/retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Post('sweep')
  @UseGuards(InternalAuthGuard)
  async sweep() {
    return this.retention.sweepExpiredCalls();
  }
}