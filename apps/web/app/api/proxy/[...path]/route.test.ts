import { describe, expect, it } from 'vitest';
import { isNullBodyStatus, relayJsonResponse } from './route';

describe('isNullBodyStatus', () => {
  it.each([101, 204, 205, 304])('treats %i as a null-body status', (status) => {
    expect(isNullBodyStatus(status)).toBe(true);
  });

  it.each([200, 201, 400, 404, 500])('treats %i as a body-bearing status', (status) => {
    expect(isNullBodyStatus(status)).toBe(false);
  });
});

describe('relayJsonResponse', () => {
  it('relays a 204 as a clean, body-free 204', async () => {
    const upstream = new Response(null, { status: 204 });

    const relayed = await relayJsonResponse(upstream);

    expect(relayed.status).toBe(204);
    expect(await relayed.text()).toBe('');
  });

  it('relays a JSON body with its upstream status', async () => {
    const upstream = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const relayed = await relayJsonResponse(upstream);

    expect(relayed.status).toBe(200);
    expect(await relayed.json()).toEqual({ ok: true });
  });

  it('falls back to an empty object when the upstream body is not JSON', async () => {
    const upstream = new Response('not json', { status: 502 });

    const relayed = await relayJsonResponse(upstream);

    expect(relayed.status).toBe(502);
    expect(await relayed.json()).toEqual({});
  });
});
