import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { env } from '../config/env';
import { CallsService } from './calls.service';

interface WebhookPayload {
  event_type: string;
  provider_call_id?: string;
  data?: Record<string, unknown>;
}

/**
 * Public endpoint that receives provider webhooks (Vapi / Retell).
 * Verifies HMAC signature against per-provider webhook secret before
 * any DB write. Failed signatures are audited and rejected with 401.
 */
@Controller('voice/webhooks')
export class VoiceWebhookController {
  private readonly logger = new Logger(VoiceWebhookController.name);

  constructor(
    private readonly calls: CallsService,
    private readonly audit: AuditService,
  ) {}

  @Post(':provider')
  @HttpCode(204)
  async receive(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string>,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<void> {
    const rawBody = req.rawBody ?? (req.body ? Buffer.from(JSON.stringify(req.body)) : Buffer.alloc(0));
    if (!this.verifySignature(provider, headers, rawBody)) {
      this.logger.warn(`Rejected ${provider} webhook: invalid signature`);
      await this.audit.log({
        workspaceId: null,
        actorUserId: null,
        action: 'voice.webhook.rejected',
        resourceType: 'voice_webhook',
        resourceId: provider,
        metadata: { reason: 'invalid_signature' },
      });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }

    // Provider event payloads use varied shapes — normalize before passing in.
    const normalized = normalizeProviderEvent(provider, payload);
    await this.calls.ingestEvent(provider, normalized);
  }

  private verifySignature(
    provider: string,
    headers: Record<string, string>,
    rawBody: Buffer,
  ): boolean {
    const secret = secretFor(provider);
    // If no secret configured, allow in non-production for local dev only.
    if (!secret) {
      if (env.NODE_ENV === 'production') return false;
      this.logger.warn(
        `No webhook secret configured for ${provider}; allowing in ${env.NODE_ENV} mode only.`,
      );
      return true;
    }

    const headerName = signatureHeader(provider);
    const provided = headers[headerName] ?? headers[headerName.toLowerCase()];
    if (!provided) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const providedHex = provided.replace(/^sha256=/, '').trim();
    if (providedHex.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }
}

function secretFor(provider: string): string | undefined {
  switch (provider.toLowerCase()) {
    case 'vapi':
      return env.VAPI_WEBHOOK_SECRET;
    case 'retell':
      return env.RETELL_WEBHOOK_SECRET;
    default:
      return undefined;
  }
}

function signatureHeader(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'vapi':
      return 'x-vapi-signature';
    case 'retell':
      return 'x-retell-signature';
    default:
      return 'x-signature';
  }
}

/**
 * Map provider-native event payloads to the internal shape `CallsService.ingestEvent` expects.
 * Both Vapi and Retell wrap data under `message` / `event` envelopes.
 */
function normalizeProviderEvent(
  provider: string,
  raw: WebhookPayload | Record<string, unknown>,
): WebhookPayload {
  if (provider.toLowerCase() === 'vapi') {
    const msg = (raw as { message?: Record<string, unknown> }).message ?? raw;
    const type = (msg as { type?: string }).type;
    const call = (msg as { call?: Record<string, unknown> }).call ?? {};
    const eventType = mapVapiEvent(type);
    if (!eventType) return raw as WebhookPayload;
    return {
      event_type: eventType,
      provider_call_id: (call as { id?: string }).id,
      data: {
        ...msg,
        transcript: (msg as { transcript?: string }).transcript,
        recording_url:
          (msg as { recordingUrl?: string }).recordingUrl ??
          ((msg as { artifact?: { recordingUrl?: string } }).artifact?.recordingUrl),
        from_number: (call as { customer?: { number?: string } }).customer?.number,
        to_number: (call as { phoneNumber?: { number?: string } }).phoneNumber?.number,
        provider_runtime_id: (call as { assistantId?: string }).assistantId,
        outcome: (msg as { endedReason?: string }).endedReason,
      },
    };
  }

  if (provider.toLowerCase() === 'retell') {
    const event = (raw as { event?: string }).event;
    const call = (raw as { call?: Record<string, unknown> }).call ?? {};
    const eventType = mapRetellEvent(event);
    if (!eventType) return raw as WebhookPayload;
    return {
      event_type: eventType,
      provider_call_id: (call as { call_id?: string }).call_id,
      data: {
        ...call,
        transcript: (call as { transcript?: string }).transcript,
        recording_url: (call as { recording_url?: string }).recording_url,
        from_number: (call as { from_number?: string }).from_number,
        to_number: (call as { to_number?: string }).to_number,
        provider_runtime_id: (call as { agent_id?: string }).agent_id,
        outcome: (call as { call_analysis?: { user_sentiment?: string } }).call_analysis
          ?.user_sentiment,
      },
    };
  }

  return raw as WebhookPayload;
}

function mapVapiEvent(type: string | undefined): string | null {
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
      return null;
  }
}

function mapRetellEvent(event: string | undefined): string | null {
  switch (event) {
    case 'call_started':
      return 'call.started';
    case 'call_ended':
    case 'call_analyzed':
      return 'call.ended';
    default:
      return null;
  }
}
