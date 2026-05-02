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

    await this.callsService.ingestEvent(provider, normalizeProviderEvent(provider, body));
    return { received: true };
  }
}

interface NormalizedEvent {
  event_type: string;
  provider_call_id?: string;
  data?: Record<string, unknown>;
}

/**
 * Map provider-native event payloads (Vapi `message` envelope, Retell `event`
 * envelope) to the internal shape `CallsService.ingestEvent` expects.
 */
function normalizeProviderEvent(provider: string, body: unknown): NormalizedEvent {
  if (provider === 'vapi') {
    const msg = ((body as { message?: Record<string, unknown> })?.message ?? body) as Record<string, unknown>;
    const type = msg.type as string | undefined;
    const call = (msg.call as Record<string, unknown> | undefined) ?? {};
    return {
      event_type: mapVapiEvent(type),
      provider_call_id: (call as { id?: string }).id,
      data: {
        ...msg,
        transcript: (msg.transcript as string | undefined),
        recording_url:
          (msg.recordingUrl as string | undefined) ??
          ((msg.artifact as { recordingUrl?: string } | undefined)?.recordingUrl),
        from_number: (call as { customer?: { number?: string } }).customer?.number,
        to_number: (call as { phoneNumber?: { number?: string } }).phoneNumber?.number,
        provider_runtime_id: (call as { assistantId?: string }).assistantId,
        outcome: (msg.endedReason as string | undefined),
      },
    };
  }
  if (provider === 'retell') {
    const event = (body as { event?: string })?.event;
    const call = ((body as { call?: Record<string, unknown> })?.call ?? {}) as Record<string, unknown>;
    return {
      event_type: mapRetellEvent(event),
      provider_call_id: call.call_id as string | undefined,
      data: {
        ...call,
        transcript: call.transcript as string | undefined,
        recording_url: call.recording_url as string | undefined,
        from_number: call.from_number as string | undefined,
        to_number: call.to_number as string | undefined,
        provider_runtime_id: call.agent_id as string | undefined,
        outcome:
          (call.call_analysis as { user_sentiment?: string } | undefined)?.user_sentiment,
      },
    };
  }
  return body as NormalizedEvent;
}

function mapVapiEvent(type: string | undefined): string {
  switch (type) {
    case 'status-update':
    case 'call-start':
      return 'call.started';
    case 'end-of-call-report':
      return 'call.ended';
    case 'transcript':
      return 'call.transcript';
    case 'function-call':
      return 'call.tool_invoked';
    default:
      return type ?? 'unknown';
  }
}

function mapRetellEvent(event: string | undefined): string {
  switch (event) {
    case 'call_started':
      return 'call.started';
    case 'call_ended':
    case 'call_analyzed':
      return 'call.ended';
    default:
      return event ?? 'unknown';
  }
}