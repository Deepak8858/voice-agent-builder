import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CallsService } from './calls.service';

interface WebhookPayload {
  event_type: string;
  provider_call_id?: string;
  data?: Record<string, unknown>;
}

/**
 * Public endpoint that receives provider webhooks (Vapi / Retell). HMAC
 * verification will be added in Phase 6 once we wire real providers; for now
 * this records events into call_events and updates the parent call status
 * when `event_type === 'call.ended'`.
 */
@Controller('voice/webhooks')
export class VoiceWebhookController {
  constructor(private readonly calls: CallsService) {}

  @Post(':provider')
  @HttpCode(204)
  async receive(
    @Param('provider') provider: string,
    @Body() payload: WebhookPayload,
  ): Promise<void> {
    await this.calls.ingestEvent(provider, payload);
  }
}
