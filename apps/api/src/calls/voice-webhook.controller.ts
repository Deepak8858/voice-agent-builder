import { Body, Controller, Headers, HttpCode, Logger, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { env, isProduction } from '../config/env';
import { Public } from '../common/decorators/public.decorator';
import { SkipRateLimit } from '../common/rate-limit.guard';
import { CallsService } from './calls.service';

@Public()
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
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ): Promise<{ received: boolean }> {
    const secret = env.VOICE_WEBHOOK_SECRET;
    const sig = provider === 'vapi' ? vapiSig : undefined;

    if (secret && sig) {
      // Use raw body Buffer for deterministic HMAC — key order/whitespace stable
      const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(body), 'utf8');
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        throw new UnauthorizedException('Invalid webhook signature');
      }
    } else if (isProduction() || !secret) {
      throw new UnauthorizedException('Missing webhook secret');
    }

    const event = body as Record<string, unknown>;
    await this.callsService.ingestEvent(provider, {
      event_type: String(event['event_type'] ?? 'unknown'),
      provider_call_id: event['provider_call_id'] as string | undefined,
      data: event['data'] as Record<string, unknown> | undefined,
    });
    return { received: true };
  }
}