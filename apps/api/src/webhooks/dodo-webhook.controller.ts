import {
  BadRequestException,
  Controller,
  Headers,
  InternalServerErrorException,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { DodoWebhookService } from './dodo-webhook.service';

@Public()
@Controller('webhooks/dodo')
export class DodoWebhookController {
  constructor(private readonly service: DodoWebhookService) {}

  @Post()
  async handleWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    // Standard Webhooks: the id is the delivery's only stable identifier, and all
    // three are required to verify the signature over the raw body.
    @Headers('webhook-id') webhookId: string,
    @Headers('webhook-signature') signature: string,
    @Headers('webhook-timestamp') timestamp: string,
  ): Promise<{ ok: boolean; message: string }> {
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException('No raw body');
    }
    const result = await this.service.handleWebhook(rawBody, {
      webhookId,
      signature,
      timestamp,
    });
    if (!result.handled) {
      if (result.statusCode === 400) {
        throw new BadRequestException(result.message);
      }
      throw new InternalServerErrorException(result.message);
    }
    return { ok: true, message: result.message };
  }
}
