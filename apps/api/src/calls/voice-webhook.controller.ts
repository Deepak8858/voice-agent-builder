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
    @Headers('x-vapi-timestamp') vapiTimestamp?: string,
  ): Promise<{ received: boolean }> {
    const secret = env.VOICE_WEBHOOK_SECRET;
    const sig = provider === 'vapi' ? vapiSig : undefined;

    if (!secret) {
      throw new UnauthorizedException('Missing webhook secret');
    }
    if (!sig) {
      throw new UnauthorizedException('Missing webhook signature');
    }
    if (!req.rawBody) {
      throw new UnauthorizedException('Missing raw webhook body');
    }
    if (isProduction() && !vapiTimestamp) {
      throw new UnauthorizedException('Missing webhook timestamp');
    }
    if (vapiTimestamp && !isRecentTimestamp(vapiTimestamp)) {
      throw new UnauthorizedException('Stale webhook timestamp');
    }

    const signedPayload = vapiTimestamp
      ? Buffer.concat([Buffer.from(`${vapiTimestamp}.`, 'utf8'), req.rawBody])
      : req.rawBody;
    const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = body as Record<string, unknown>;
    await this.callsService.ingestEvent(provider, {
      event_type: String(event['event_type'] ?? 'unknown'),
      provider_call_id: event['provider_call_id'] as string | undefined,
      provider_event_id:
        typeof event['event_id'] === 'string'
          ? event['event_id']
          : typeof event['id'] === 'string'
            ? event['id']
            : undefined,
      data: event['data'] as Record<string, unknown> | undefined,
    });
    return { received: true };
  }
}

function isRecentTimestamp(value: string): boolean {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return false;
  const timestampMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  return Math.abs(Date.now() - timestampMs) <= 5 * 60 * 1000;
}
