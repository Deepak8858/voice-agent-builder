import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppError } from '../common/errors';
import { GoogleConnectionService } from './google-connection.service';

const CallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
type CallbackDto = z.infer<typeof CallbackSchema>;

@Controller('workspaces/:workspaceId/google')
@UseGuards(InternalAuthGuard, WorkspaceGuard)
export class GoogleConnectionController {
  constructor(private readonly google: GoogleConnectionService) {}

  /** Returns the Google consent URL and the signed CSRF `state`. */
  @Get('authorize')
  authorize(@Param('workspaceId') workspaceId: string) {
    return this.google.getAuthorizeUrl(workspaceId);
  }

  /** Browser redirect target forwarded through the web app (GET form). */
  @Get('callback')
  async callbackGet(
    @Param('workspaceId') workspaceId: string,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ) {
    if (!code || !state) {
      throw new AppError('VALIDATION_ERROR', 'code and state are required.', 400);
    }
    return this.google.completeOAuthCallback({ workspaceId, code, state });
  }

  /** Same exchange as GET, for callers that forward the callback as JSON. */
  @Post('callback')
  async callbackPost(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CallbackSchema)) body: CallbackDto,
  ) {
    return this.google.completeOAuthCallback({
      workspaceId,
      code: body.code,
      state: body.state,
    });
  }

  @Get('status')
  async status(@Param('workspaceId') workspaceId: string) {
    return this.google.getStatus(workspaceId);
  }

  @Delete('disconnect')
  async disconnect(@Param('workspaceId') workspaceId: string) {
    await this.google.disconnect(workspaceId);
    return { success: true };
  }
}
