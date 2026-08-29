import { Controller, Post, UseGuards } from '@nestjs/common';
import { RetentionService } from './retention.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { InternalOnly } from '../common/decorators/internal-only.decorator';

/**
 * Manual trigger for the retention sweep. The Next.js proxy forwards any path
 * with the internal key attached, so without @InternalOnly() any signed-in
 * tenant user could fire a platform-wide destructive sweep. The decorator
 * keeps it reachable exactly one way: an operator sending the bare internal
 * key with no user bearer.
 */
@InternalOnly()
@Controller('admin/retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Post('sweep')
  @UseGuards(InternalAuthGuard)
  async sweep() {
    return this.retention.sweepExpiredCalls();
  }
}