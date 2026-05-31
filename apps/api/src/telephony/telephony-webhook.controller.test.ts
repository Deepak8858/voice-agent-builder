import { describe, expect, it, vi } from 'vitest';
import { TelephonyWebhookController } from './telephony-webhook.controller';

describe('TelephonyWebhookController', () => {
  it('passes Vobiz status webhook headers, raw body, and URL into the service', async () => {
    const telephony = {
      handleStatusWebhook: vi.fn(async () => ({ processed: true })),
    };
    const controller = new TelephonyWebhookController(telephony as never);
    const headers = {
      'x-vobiz-signature': 'signature',
      'x-vobiz-timestamp': '1770000000',
    };
    const req = {
      originalUrl: '/api/v1/telephony/vobiz/status/number-1',
      url: '/api/v1/telephony/vobiz/status/number-1',
      rawBody: Buffer.from('{"call_id":"call-1","status":"completed"}'),
    };

    await (controller.vobizStatus as never as (...args: unknown[]) => Promise<unknown>)(
      'number-1',
      { call_id: 'call-1', status: 'completed' },
      headers,
      req,
    );

    expect(telephony.handleStatusWebhook).toHaveBeenCalledWith(
      'vobiz',
      'number-1',
      { call_id: 'call-1', status: 'completed' },
      {
        headers,
        rawBody: '{"call_id":"call-1","status":"completed"}',
        url: expect.stringMatching(/\/api\/v1\/telephony\/vobiz\/status\/number-1$/),
      },
    );
  });
});
