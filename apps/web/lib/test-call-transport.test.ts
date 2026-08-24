import { describe, expect, it } from 'vitest';
import type { TestSessionResult } from '@voiceforge/shared';
import { resolveTestCallTransport } from './test-call-transport';

function session(overrides: Partial<TestSessionResult> = {}): TestSessionResult {
  return {
    call_id: '11111111-1111-4111-8111-111111111111',
    test_session_id: 'call-test-1',
    pipeline: 'standard',
    web_socket_url: null,
    livekit_url: 'wss://voiceforge.livekit.cloud',
    room_name: 'call-test-1',
    token: 'jwt-token',
    expires_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('resolveTestCallTransport', () => {
  it('joins the LiveKit room for an in-house pipeline session', () => {
    expect(resolveTestCallTransport(session())).toEqual({
      kind: 'livekit',
      url: 'wss://voiceforge.livekit.cloud',
      token: 'jwt-token',
      roomName: 'call-test-1',
    });
  });

  it('does not join a room for a realtime session', () => {
    const transport = resolveTestCallTransport(
      session({
        pipeline: 'realtime',
        livekit_url: null,
        room_name: null,
        web_socket_url: 'wss://api.openai.com/v1/realtime',
      }),
    );

    expect(transport).toEqual({ kind: 'none', reason: 'realtime_session' });
  });

  it.each([
    ['url', { livekit_url: null }],
    ['token', { token: null }],
    ['room name', { room_name: null }],
    ['blank url', { livekit_url: '   ' }],
    ['blank token', { token: '   ' }],
  ])('refuses to connect when the %s is missing', (_label, overrides) => {
    const transport = resolveTestCallTransport(session(overrides as Partial<TestSessionResult>));

    expect(transport).toEqual({ kind: 'none', reason: 'missing_livekit_credentials' });
  });
});
