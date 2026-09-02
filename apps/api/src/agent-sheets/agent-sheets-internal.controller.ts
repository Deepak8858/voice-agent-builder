import { Body, Controller, Post } from '@nestjs/common';
import type { CallerDetailsRequest, CallerDetailsResponse } from '@voiceforge/shared';
import { CallerDetailsRequestSchema } from '@voiceforge/shared';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AgentSheetService } from './agent-sheet.service';

/**
 * The runtime's `save_caller_details` tool lands here. @InternalOnly() proves
 * the request came from our own runtime; the call -> agent binding is the only
 * thing trusted from the body (the same rule as the tools route), and the
 * workspace, sheet and columns all come from the verified call row.
 */
@InternalOnly()
@Controller('internal/runtime/caller-details')
export class AgentSheetsInternalController {
  constructor(private readonly sheets: AgentSheetService) {}

  @Post()
  record(
    @Body(new ZodValidationPipe(CallerDetailsRequestSchema)) body: CallerDetailsRequest,
  ): Promise<CallerDetailsResponse> {
    return this.sheets.recordCallerDetails(body);
  }
}
