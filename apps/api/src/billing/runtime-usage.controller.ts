import { Body, Controller, Post } from '@nestjs/common';
import type { RuntimeUsageDecision, RuntimeUsageEvent } from '@voiceforge/shared';
import { RuntimeUsageEventSchema } from '@voiceforge/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RuntimeUsageService } from './runtime-usage.service';

/**
 * Metering ingestion for the voice runtime. The global InternalAuthGuard
 * protects this route with x-internal-key, so it is reachable only from our own
 * runtime and never from a browser. The organization in the body is verified
 * against the persisted call before any credit moves.
 */
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
