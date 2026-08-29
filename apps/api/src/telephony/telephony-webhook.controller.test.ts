import { describe, expect, it, vi } from 'vitest';
import { TelephonyWebhookController } from './telephony-webhook.controller';

function makeTelephony() {
  return {
    handleStatusWebhook: vi.fn(async () => ({ processed: true })),
    handleVobizInboundWebhook: vi.fn(async () => ({ processed: true, admitted: true })),
    handleVobizVerifyWebhook: vi.fn(async () => ({ processed: true })),
  };
}

const VOBIZ_REQUEST = {
  originalUrl: '/api/v1/telephony/vobiz/inbound/number-1',
  url: '/api/v1/telephony/vobiz/inbound/number-1',
  rawBody: Buffer.from('{"call_id":"call-1"}'),
};

describe('TelephonyWebhookController', () => {
  it('passes Vobiz status webhook headers, raw body, and URL into the service', async () => {
    const telephony = makeTelephony();
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

  it('routes a Vobiz inbound webhook into the inbound-call path, not the status recorder', async () => {
    const telephony = makeTelephony();
    const controller = new TelephonyWebhookController(telephony as never);
    const headers = { 'x-vobiz-signature': 'signature' };

    await (controller.vobizInbound as never as (...args: unknown[]) => Promise<unknown>)(
      'number-1',
      { call_id: 'call-1' },
      headers,
      VOBIZ_REQUEST,
    );

    expect(telephony.handleVobizInboundWebhook).toHaveBeenCalledWith(
      'number-1',
      { call_id: 'call-1' },
      expect.objectContaining({ headers, rawBody: '{"call_id":"call-1"}' }),
    );
    expect(telephony.handleStatusWebhook).not.toHaveBeenCalled();
  });

  it('routes a Vobiz verification webhook to its own handler', async () => {
    const telephony = makeTelephony();
    const controller = new TelephonyWebhookController(telephony as never);
    const headers = { 'x-vobiz-signature': 'signature' };

    await (controller.vobizVerify as never as (...args: unknown[]) => Promise<unknown>)(
      'number-1',
      { event_id: 'evt-1' },
      headers,
      VOBIZ_REQUEST,
    );

    expect(telephony.handleVobizVerifyWebhook).toHaveBeenCalledWith(
      'number-1',
      { event_id: 'evt-1' },
      expect.objectContaining({ headers, rawBody: '{"call_id":"call-1"}' }),
    );
    expect(telephony.handleStatusWebhook).not.toHaveBeenCalled();
    expect(telephony.handleVobizInboundWebhook).not.toHaveBeenCalled();
  });
});
