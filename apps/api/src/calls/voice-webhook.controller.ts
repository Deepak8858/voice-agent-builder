import { Controller, Post, Body, Headers, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { CallsService } from './calls.service';

function verifyHmac(payload: string, sig: string, secret: string): boolean {
  if (!secret || !sig) return process.env.NODE_ENV !== 'production';
  try {
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch { return false; }
}

@Controller('webhooks/voice')
export class VoiceWebhookController {
  constructor(private readonly callsService: CallsService) {}

  @Post('vapi')
  @HttpCode(HttpStatus.OK)
  async vapiWebhook(@Req() req: Request, @Headers('x-vapi-signature') sig: string) {
    const raw = (req as any).rawBody ? (req as any).rawBody.toString() : JSON.stringify(req.body);
    if (!verifyHmac(raw, sig, process.env.VAPI_WEBHOOK_SECRET ?? '')) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[VoiceWebhook] Vapi HMAC skipped in dev');
      } else {
        return { error: 'Unauthorized' };
      }
    }
    const event = JSON.parse(raw);
    await this.callsService.ingestEvent({ provider: 'vapi', event });
    return { received: true };
  }

  @Post('retell')
  @HttpCode(HttpStatus.OK)
  async retellWebhook(@Body() body: unknown, @Headers('x-retell-signature') sig: string) {
    const payload = JSON.stringify(body);
    if (!verifyHmac(payload, sig, process.env.RETELL_WEBHOOK_SECRET ?? '')) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[VoiceWebhook] Retell HMAC skipped in dev');
      } else {
        return { error: 'Unauthorized' };
      }
    }
    await this.callsService.ingestEvent({ provider: 'retell', event: body });
    return { received: true };
  }
}
