import { describe, expect, it, vi } from 'vitest';
import { createToolInvokeClient, stableJson } from './google-tools';

/**
 * The idempotency key must be derived purely from what the call is (callId,
 * tool, params), never from how the LLM happened to serialize the params.
 * These tests pin both halves of that contract: identical requests always
 * produce the same key, and any semantic difference produces a different one.
 */

function invokeOkResponse(): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: { status: 'success', result: null, error_message: null },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Runs one invocation through createToolInvokeClient with a stubbed fetch and
 * returns the parsed request body, so tests assert on what would actually be
 * sent over the wire rather than on private helpers.
 */
async function invokedBody(options: {
  params: Record<string, unknown>;
  toolName?: string;
  toolType?: string;
  callId?: string;
}): Promise<Record<string, unknown>> {
  const fetchImpl = vi.fn(async () => invokeOkResponse());
  const invoke = createToolInvokeClient({
    apiBaseUrl: 'http://api:4000',
    internalApiKey: 'internal-key',
    agentId: 'agent-1',
    callId: options.callId ?? 'call-1',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  await invoke(
    options.toolName ?? 'book_meeting',
    options.params,
    options.toolType ?? 'google_calendar',
  );

  const call = fetchImpl.mock.calls[0];
  if (!call) throw new Error('fetch was not invoked');
  const [, init] = call as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

async function invokedKey(options: {
  params: Record<string, unknown>;
  toolName?: string;
  toolType?: string;
  callId?: string;
}): Promise<string> {
  const body = await invokedBody(options);
  const key = body.idempotency_key;
  if (typeof key !== 'string') throw new Error('idempotency_key was not sent');
  return key;
}

const createEventParams = {
  operation: 'create_event',
  summary: 'Dentist',
  start_iso: '2026-09-01T10:00:00Z',
  end_iso: '2026-09-01T10:30:00Z',
  attendees: ['a@example.com', 'b@example.com'],
};

describe('tool invoke idempotency key', () => {
  it('serializes sparse array entries as null, matching JSON.stringify', () => {
    const sparse = Array<unknown>(1);

    expect(stableJson(sparse)).toBe(JSON.stringify(sparse));
    expect(stableJson(sparse)).toBe('[null]');
  });

  it('emits a 64-char lowercase hex sha256 digest', async () => {
    const key = await invokedKey({ params: createEventParams, callId: 'call-1' });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across object key insertion order, including nested objects and objects in arrays', async () => {
    // JSON.stringify preserves insertion order, so a naive hash of the params
    // would treat these as different requests and defeat deduplication.
    const ordered = {
      operation: 'create_event',
      summary: 'Sync',
      extended: { color: 'blue', reminder: { minutes: 10, method: 'popup' } },
      attendees: [{ email: 'a@example.com', optional: false }],
    };
    const shuffled = {
      attendees: [{ optional: false, email: 'a@example.com' }],
      extended: { reminder: { method: 'popup', minutes: 10 }, color: 'blue' },
      summary: 'Sync',
      operation: 'create_event',
    };

    expect(await invokedKey({ params: ordered, callId: 'call-1' })).toBe(
      await invokedKey({ params: shuffled, callId: 'call-1' }),
    );
  });

  it('treats array element order as significant', async () => {
    // Arrays are ordered data; sorting them would make genuinely different
    // requests (e.g. column values for a row) collide.
    const forward = { ...createEventParams, attendees: ['a@example.com', 'b@example.com'] };
    const reversed = { ...createEventParams, attendees: ['b@example.com', 'a@example.com'] };

    expect(await invokedKey({ params: forward, callId: 'call-1' })).not.toBe(
      await invokedKey({ params: reversed, callId: 'call-1' }),
    );
  });

  it('changes when params, tool name, or call id change', async () => {
    const base = await invokedKey({ params: createEventParams, callId: 'call-1' });

    expect(
      await invokedKey({
        params: { ...createEventParams, summary: 'Different' },
        callId: 'call-1',
      }),
    ).not.toBe(base);
    expect(
      await invokedKey({
        params: createEventParams,
        toolName: 'other_calendar_tool',
        callId: 'call-1',
      }),
    ).not.toBe(base);
    expect(await invokedKey({ params: createEventParams, callId: 'call-2' })).not.toBe(base);
  });

  it('is deterministic for repeated identical invocations', async () => {
    expect(await invokedKey({ params: createEventParams, callId: 'call-1' })).toBe(
      await invokedKey({ params: createEventParams, callId: 'call-1' }),
    );
  });

  it('distinguishes an omitted key from an explicit null, matching the wire payload', async () => {
    // JSON.stringify drops undefined-valued keys but keeps null ones, so the two
    // requests below send different bodies. Hashing them identically would let
    // the server replay one request's result for the other.
    const withUndefined = await invokedKey({
      params: { ...createEventParams, description: undefined },
      callId: 'call-1',
    });
    const withNull = await invokedKey({
      params: { ...createEventParams, description: null },
      callId: 'call-1',
    });
    const withoutField = await invokedKey({ params: createEventParams, callId: 'call-1' });

    expect(withUndefined).not.toBe(withNull);
    // An undefined value is not sent at all, so it must hash like an absent key.
    expect(withUndefined).toBe(withoutField);
  });

  it('does not collapse distinct dates to the same key', async () => {
    // A Date has no enumerable own entries, so serializing it as a plain object
    // would reduce every date to '{}' and make all of them collide.
    const first = await invokedKey({
      params: { ...createEventParams, start_iso: new Date('2026-09-01T10:00:00Z') },
      callId: 'call-1',
    });
    const second = await invokedKey({
      params: { ...createEventParams, start_iso: new Date('2026-09-02T10:00:00Z') },
      callId: 'call-1',
    });

    expect(first).not.toBe(second);
    // A Date and its own ISO string serialize identically on the wire, so they
    // must hash identically too.
    expect(first).toBe(
      await invokedKey({
        params: { ...createEventParams, start_iso: '2026-09-01T10:00:00.000Z' },
        callId: 'call-1',
      }),
    );
  });

  it('is only sent for google_calendar create_event', async () => {
    // Other operations are reads (or non-calendar tools), where retrying is
    // harmless; the key is scoped to the one operation that creates state.
    const gmailBody = await invokedBody({
      params: { to: 'x@example.com', subject: 'Hi', body: 'Hello' },
      toolType: 'gmail',
      callId: 'call-1',
    });
    expect(gmailBody).not.toHaveProperty('idempotency_key');

    const listBody = await invokedBody({
      params: { operation: 'list_events' },
      callId: 'call-1',
    });
    expect(listBody).not.toHaveProperty('idempotency_key');
  });

  it('always sends the bound call id', async () => {
    // The internal route refuses requests without a call bound to the agent,
    // so the client must never omit it.
    const body = await invokedBody({ params: { operation: 'list_events' }, callId: 'call-9' });
    expect(body).toMatchObject({ call_id: 'call-9' });
  });
});
