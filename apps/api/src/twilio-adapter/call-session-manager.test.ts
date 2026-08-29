import { describe, expect, it } from 'vitest';
import { CallSessionManager } from './call-session-manager';

const PARAMS = {
  callSid: 'CA_test',
  agentId: 'agent_1',
  agentVersionId: 'ver_1',
  workspaceId: 'ws_1',
  direction: 'inbound' as const,
};

/**
 * The session id is emitted to Twilio inside
 * `<Stream url="wss://.../voice/stream/<id>">`, so it is a bearer capability in
 * a URL rather than a private map key. It used to be
 * `session_${Date.now()}_${Math.random().toString(36).slice(2)}`: the clock half
 * is not a secret and V8's PRNG state is recoverable from a handful of outputs,
 * so ids were predictable.
 *
 * These assertions are shaped to FAIL for that construction, not merely to
 * describe the current one -- a `toBeTruthy()` on the id would have passed
 * against the defect.
 */
describe('CallSessionManager id generation', () => {
  const uuidV4 = /^session_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('draws the id from a CSPRNG, not from the clock and Math.random', () => {
    const id = new CallSessionManager().create(PARAMS).id;

    expect(id).toMatch(uuidV4);
    // The old format leaked creation time; `startedAt` carries it instead.
    expect(id).not.toContain(String(Date.now()).slice(0, 8));
  });

  it('never repeats an id across many sessions', () => {
    const manager = new CallSessionManager();
    const ids = new Set(Array.from({ length: 500 }, () => manager.create(PARAMS).id));

    expect(ids.size).toBe(500);
  });

  it('stores and retrieves the session under its generated id', () => {
    const manager = new CallSessionManager();
    const session = manager.create(PARAMS);

    expect(manager.get(session.id)).toBe(session);
    expect(manager.getByCallSid('CA_test')).toBe(session);
    expect(manager.get('session_guessed')).toBeUndefined();
  });
});
