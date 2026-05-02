import { Body, Controller, Headers, HttpCode, Logger, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { SkipRateLimit } from '../common/rate-limit.guard';
import { CallsService } from './calls.service';

@Controller('voice/webhooks')
export class VoiceWebhookController {
  private readonly logger = new Logger(VoiceWebhookController.name);

  constructor(private readonly callsService: CallsService) {}

  @Post(':provider')
  @HttpCode(204)
  @SkipRateLimit()
  async receive(
    @Param('provider') provider: string,
    @Headers('x-vapi-signature') vapiSig: string | undefined,
    @Headers('x-retell-signature') retellSig: string | undefined,
    @Body() body: unknown,
  ): Promise<{ received: boolean }> {
    const raw = JSON.stringify(body);
    const secret = provider === 'vapi' ? env.VAPI_WEBHOOK_SECRET : provider === 'retell' ? env.RETELL_WEBHOOK_SECRET : env.VOICE_WEBHOOK_SECRET;
    const sig = provider === 'vapi' ? vapiSig : provider === 'retell' ? retellSig : undefined;

    if (secret && sig) {
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        if (env.NODE_ENV === 'production') {
          throw new UnauthorizedException('Invalid webhook signature');
        }
        this.logger.warn(`Voice webhook HMAC skipped in non-production (${provider})`);
      }
    } else if (env.NODE_ENV === 'production') {
      throw new UnauthorizedException('Missing webhook secret');
    }

    await this.callsService.ingestEvent({ provider, event: body });
    return { received: true };
  }
}