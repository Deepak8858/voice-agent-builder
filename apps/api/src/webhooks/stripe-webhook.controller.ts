import { Controller, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { StripeWebhookService } from './stripe-webhook.service';

@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(private readonly service: StripeWebhookService) {}

  @Post()
  async handleWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string,
  ): Promise<{ ok: boolean; message: string }> {
    const rawBody = req.rawBody;
    if (!rawBody) {
      return { ok: false, message: 'No raw body' };
    }
    const result = await this.service.handleWebhook(rawBody, signature);
    return { ok: result.handled, message: result.message };
  }
}