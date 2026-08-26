import { Body, Controller, Post } from '@nestjs/common';
import type { RuntimeUsageDecision, RuntimeUsageEvent } from '@voiceforge/shared';
import { RuntimeUsageEventSchema } from '@voiceforge/shared';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RuntimeUsageService } from './runtime-usage.service';

/**
 * Metering ingestion for the voice runtime. The organization in the body is
 * verified against the persisted call before any credit moves.
 *
 * `x-internal-key` alone does not keep a browser out: the Next.js proxy
 * forwards any path and attaches that key itself, so a signed-in user could
 * post a forged `call_ended` for one of their own calls and have the reserved
 * minute refunded mid-call. @InternalOnly() is what makes the "runtime only"
 * claim true — a request carrying user context is refused by
 * InternalAuthGuard before it reaches this handler.
 */
@InternalOnly()
@Controller('internal/runtime/usage')
export class RuntimeUsageController {
  constructor(private readonly runtimeUsage: RuntimeUsageService) {}

  @Post('events')
  async ingest(
    @Body(new ZodValidationPipe(RuntimeUsageEventSchema)) event: RuntimeUsageEvent,
  ): Promise<RuntimeUsageDecision> {
    return this.runtimeUsage.handleEvent(event);
  }
}
