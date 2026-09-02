import { describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import { ParticipantKind, RoomEvent } from '@livekit/rtc-node';
import { createHandoffClient, createTransferTool, type HandoffDialer } from './handoff';

const spec: AgentSpec = {
  name: 'Order desk',
  identity: { agent_name: 'Asha', business_name: 'Vinod Medical Store' },
  industry: 'retail',
  language: 'en',
  voice: { tone: 'friendly' },
  goals: ['Take orders'],
  required_fields: [],
  conversation_rules: {
    ask_one_question_at_a_time: true,
    confirm_critical_information: true,
    do_not_make_up_answers: true,
    fallback_to_human_when_unsure: true,
  },
  compliance: {
    opt_out_enabled: false,
    ai_disclosure_required: true,
    recording_notice_required: false,
  },
  knowledge: { retrieval_mode: 'none', max_chunks: 0 },
  tools: [],
  handoff: { enabled: true, target_phone: '8858901717', conditions: ['caller_requests_human'] },
} as unknown as AgentSpec;

const metadata = {
  agentId: 'agent-1',
  direction: 'inbound' as const,
  pipeline: 'realtime' as const,
};

type Listener = (participant: { kind: ParticipantKind }) => void;

function makeRoom() {
  const listeners = new Set<Listener>();
  return {
    on: vi.fn((event: string, fn: Listener) => {
      if (event === RoomEvent.ParticipantDisconnected) listeners.add(fn);
    }),
    off: vi.fn((_event: string, fn: Listener) => listeners.delete(fn)),
    leave: (kind: ParticipantKind) => listeners.forEach((fn) => fn({ kind })),
    listenerCount: () => listeners.size,
  };
}

function makeSession() {
  const playout = vi.fn(async () => undefined);
  return {
    input: { setAudioEnabled: vi.fn() },
    output: { setAudioEnabled: vi.fn() },
    generateReply: vi.fn(() => ({ waitForPlayout: playout })),
    playout,
  };
}

function makeTool(options: { dial: HandoffDialer; room?: ReturnType<typeof makeRoom> }) {
  const room = options.room ?? makeRoom();
  const stopHold = vi.fn(async () => undefined);
  const holdMusic = vi.fn(async () => stopHold);
  const onTransferEnded = vi.fn();
  const tool = createTransferTool({
    spec,
    metadata,
    callId: 'call-1',
    room: room as never,
    dial: options.dial,
    onTransferEnded,
    holdMusic,
  });
  if (!tool) throw new Error('tool was not created');
  const execute = (
    tool as unknown as { execute: (args: unknown, opts: unknown) => Promise<unknown> }
  ).execute;
  const session = makeSession();
  const run = () => execute({ summary: 'Deepak needs a refill.' }, { ctx: { session } });
  return { run, session, room, holdMusic, stopHold, onTransferEnded };
}

/**
 * 2026-09-02: the only handoff the agent could perform was an apology. The
 * approved shape is the announced warm transfer: hold, dial, introduce, step
 * out, keep metering until someone hangs up.
 */
describe('transfer_to_human tool', () => {
  it('is not offered when there is nobody to dial or no line to dial on', () => {
    const dial = vi.fn();
    expect(
      createTransferTool({
        spec: { ...spec, handoff: { enabled: true, conditions: [] } },
        metadata,
        callId: 'call-1',
        room: makeRoom() as never,
        dial,
        onTransferEnded: vi.fn(),
      }),
    ).toBeNull();
    expect(
      createTransferTool({
        spec,
        metadata: { ...metadata, direction: 'browser_test' },
        callId: 'call-1',
        room: makeRoom() as never,
        dial,
        onTransferEnded: vi.fn(),
      }),
    ).toBeNull();
  });

  it('holds the caller, introduces them to the human, then goes quiet until a leg hangs up', async () => {
    const dial = vi.fn(async () => ({
      connected: true,
      participantIdentity: 'sip-human-call-1',
      reason: null,
    }));
    const { run, session, room, holdMusic, stopHold, onTransferEnded } = makeTool({ dial });

    const result = await run();

    expect(dial).toHaveBeenCalledWith({
      callId: 'call-1',
      agentId: 'agent-1',
      summary: 'Deepak needs a refill.',
    });
    // Caller on hold: agent deaf, music on; music off once the dial settles.
    expect(session.input.setAudioEnabled).toHaveBeenCalledWith(false);
    expect(holdMusic).toHaveBeenCalledTimes(1);
    expect(stopHold).toHaveBeenCalledTimes(1);
    // The introduction carries the summary and cannot be talked over.
    expect(session.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: expect.stringContaining('Deepak needs a refill.'),
        allowInterruptions: false,
      }),
    );
    expect(session.playout).toHaveBeenCalledTimes(1);
    // A hang-up during the introduction must not be missed: the listener is in
    // place before the agent starts speaking.
    expect(room.on.mock.invocationCallOrder[0]).toBeLessThan(
      session.generateReply.mock.invocationCallOrder[0],
    );
    // Then the agent steps out but the job stays up for metering.
    expect(session.output.setAudioEnabled).toHaveBeenCalledWith(false);
    expect(result).toMatchObject({ transferred: true });
    expect(onTransferEnded).not.toHaveBeenCalled();

    // A non-SIP participant leaving is not the end of the call...
    room.leave(ParticipantKind.STANDARD);
    expect(onTransferEnded).not.toHaveBeenCalled();
    // ...either phone hanging up is, exactly once.
    room.leave(ParticipantKind.SIP);
    room.leave(ParticipantKind.SIP);
    expect(onTransferEnded).toHaveBeenCalledTimes(1);
    expect(room.listenerCount()).toBe(0);
  });

  it('gives the caller back to the agent with a message instruction when nobody answers', async () => {
    const dial = vi.fn(async () => ({
      connected: false,
      participantIdentity: null,
      reason: 'dial_failed: sip: 480 Temporarily Unavailable',
    }));
    const { run, session, stopHold, onTransferEnded } = makeTool({ dial });

    const result = await run();

    expect(stopHold).toHaveBeenCalledTimes(1);
    expect(session.input.setAudioEnabled).toHaveBeenLastCalledWith(true);
    expect(session.generateReply).not.toHaveBeenCalled();
    expect(session.output.setAudioEnabled).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      transferred: false,
      instruction: expect.stringContaining('take a message'),
    });
    expect(onTransferEnded).not.toHaveBeenCalled();
  });

  it('still steps out and keeps listening for hang-ups if the introduction fails to play', async () => {
    const dial = vi.fn(async () => ({
      connected: true,
      participantIdentity: 'sip-human-call-1',
      reason: null,
    }));
    const { run, session, room, onTransferEnded } = makeTool({ dial });
    session.playout.mockRejectedValueOnce(new Error('speech interrupted'));

    await expect(run()).resolves.toMatchObject({ transferred: true });

    expect(session.output.setAudioEnabled).toHaveBeenCalledWith(false);
    room.leave(ParticipantKind.SIP);
    expect(onTransferEnded).toHaveBeenCalledTimes(1);
  });

  it('treats a dial that throws the same as one that was not answered', async () => {
    const dial = vi.fn(async () => {
      throw new Error('[handoff] dial endpoint returned 502.');
    });
    const { run, session } = makeTool({ dial });

    await expect(run()).resolves.toMatchObject({ transferred: false });
    expect(session.input.setAudioEnabled).toHaveBeenLastCalledWith(true);
  });
});

describe('handoff client', () => {
  it('posts the call binding and summary to the internal handoff route', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { connected: true, participantIdentity: 'sip-human-call-1', reason: null },
          }),
          { status: 200 },
        ),
    );
    const dial = createHandoffClient({
      apiBaseUrl: 'http://api.internal/',
      internalApiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await dial({ callId: 'call-1', agentId: 'agent-1', summary: 'Refill.' });

    expect(result.connected).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.internal/api/v1/internal/runtime/handoff');
    expect((init.headers as Record<string, string>)['x-internal-key']).toBe('secret');
    expect(JSON.parse(init.body as string)).toEqual({
      callId: 'call-1',
      agentId: 'agent-1',
      summary: 'Refill.',
    });
  });

  it('fails loudly on a non-2xx so the tool reports the transfer as not made', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const dial = createHandoffClient({
      apiBaseUrl: 'http://api.internal',
      internalApiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(dial({ callId: 'call-1', agentId: 'agent-1', summary: 'x' })).rejects.toThrow(
      '403',
    );
  });
});
