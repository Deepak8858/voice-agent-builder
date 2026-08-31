import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DodoWebhookController } from './dodo-webhook.controller';

describe('DodoWebhookController', () => {
  it('throws BadRequestException when signature verification fails', async () => {
    const controller = new DodoWebhookController({
      handleWebhook: vi.fn(async () => ({
        handled: false,
        statusCode: 400,
        message: 'Invalid signature',
      })),
    } as never);

    await expect(
      controller.handleWebhook({ rawBody: Buffer.from('{}') } as never, 'wh_1', 'bad', '1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws InternalServerErrorException for retryable processing failures', async () => {
    const controller = new DodoWebhookController({
      handleWebhook: vi.fn(async () => ({
        handled: false,
        statusCode: 500,
        message: 'database unavailable',
      })),
    } as never);

    await expect(
      controller.handleWebhook({ rawBody: Buffer.from('{}') } as never, 'wh_1', 'v1,sig', '1'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  /**
   * The three Standard Webhooks headers must reach the service intact: the signed
   * string is built from the id and the timestamp, so dropping either would make
   * every genuine delivery fail verification (or, worse, make a forged one pass).
   */
  it('passes all three Standard Webhooks headers through', async () => {
    const handleWebhook = vi.fn(async () => ({
      handled: true,
      statusCode: 200 as const,
      message: 'ok',
    }));
    const controller = new DodoWebhookController({ handleWebhook } as never);
    const rawBody = Buffer.from('{"type":"payment.succeeded"}');

    await controller.handleWebhook({ rawBody } as never, 'wh_9', 'v1,abc', '1800000000');

    expect(handleWebhook).toHaveBeenCalledWith(rawBody, {
      webhookId: 'wh_9',
      signature: 'v1,abc',
      timestamp: '1800000000',
    });
  });

  it('rejects a request with no raw body, so nothing unverifiable is dispatched', async () => {
    const handleWebhook = vi.fn();
    const controller = new DodoWebhookController({ handleWebhook } as never);

    await expect(
      controller.handleWebhook({} as never, 'wh_1', 'v1,sig', '1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});
