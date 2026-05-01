import { Body, Controller, Headers, HttpCode, Param, Post, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { SkipRateLimit } from '../common/rate-limit.guard';
import { CallsService } from './calls.service';

interface WebhookPayload {
  event_type: string;
  provider_call_id?: string;
  data?: Record<string, unknown>;
}

/**
 * Public endpoint that receives provider webhooks (Vapi / Retell).
 * Verifies HMAC signature when VOICE_WEBHOOK_SECRET is configured.
 */
@Controller('voice/webhooks')
export class VoiceWebhookController {
  constructor(private readonly calls: CallsService) {}

  @Post(':provider')
  @HttpCode(204)
  @SkipRateLimit()
  async receive(
    @Param('provider') provider: string,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Body() payload: WebhookPayload,
  ): Promise<void> {
    this.verifySignature(provider, signature, payload);
    await this.calls.ingestEvent(provider, payload);
  }

  private verifySignature(_provider: string, signature: string | undefined, payload: WebhookPayload): void {
    const secret = env.VOICE_WEBHOOK_SECRET;
    if (!secret) {
      // No secret configured (dev mode) — accept but warn
      return;
    }
    if (!signature) {
      throw new UnauthorizedException('Missing webhook signature');
    }
    const expected = createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');
    if (expected.length !== signature.length) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    const expectedBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(signature);
    if (!timingSafeEqual(expectedBuf, sigBuf)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }
}
