import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { StripeWebhookController } from './stripe-webhook.controller';

describe('StripeWebhookController', () => {
  it('throws BadRequestException when Stripe signature verification fails', async () => {
    const controller = new StripeWebhookController({
      handleWebhook: vi.fn(async () => ({
        handled: false,
        statusCode: 400,
        message: 'Invalid signature',
      })),
    } as never);

    await expect(controller.handleWebhook({
      rawBody: Buffer.from('{}'),
    } as never, 'bad')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws InternalServerErrorException for retryable processing failures', async () => {
    const controller = new StripeWebhookController({
      handleWebhook: vi.fn(async () => ({
        handled: false,
        statusCode: 500,
        message: 'database unavailable',
      })),
    } as never);

    await expect(controller.handleWebhook({
      rawBody: Buffer.from('{}'),
    } as never, 'sig')).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
