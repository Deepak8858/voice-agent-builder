import type { TestSessionResult } from '@voiceforge/shared';

/**
 * How the browser should attach itself to a test session.
 *
 * Only the in-house (`standard`) pipeline is joinable from this client: the API
 * has already created the room and dispatched the worker into it, so the browser
 * just needs to publish a microphone track and subscribe to the agent's audio.
 * Everything else falls back to the transcript view, which is also what happens
 * for a `standard` session whose credentials are incomplete — a half-populated
 * response should degrade to "no live audio", never to a `connect()` call with
 * an empty URL or token.
 */
export type TestCallTransport =
  | { kind: 'livekit'; url: string; token: string; roomName: string }
  | { kind: 'none'; reason: TestCallTransportSkipReason };

export type TestCallTransportSkipReason =
  /** A speech-to-speech session; the browser does not join a room for it. */
  | 'realtime_session'
  /** A standard session that did not come back with a URL, token, and room. */
  | 'missing_livekit_credentials';

export function resolveTestCallTransport(session: TestSessionResult): TestCallTransport {
  if (session.pipeline !== 'standard') {
    return { kind: 'none', reason: 'realtime_session' };
  }

  const url = session.livekit_url?.trim();
  const token = session.token?.trim();
  const roomName = session.room_name?.trim();
  if (!url || !token || !roomName) {
    return { kind: 'none', reason: 'missing_livekit_credentials' };
  }

  return { kind: 'livekit', url, token, roomName };
}
