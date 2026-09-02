import { describe, expect, it, vi } from 'vitest';
import { LiveKitRemindersController } from './livekit-reminders.controller';

function makeController(options: { call?: Record<string, unknown> | null; result?: unknown } = {}) {
  const prisma = {
    call: {
      findUnique: vi.fn(async () =>
        options.call === undefined
          ? {
              id: 'call-1',
              workspaceId: 'ws-1',
              agentId: 'agent-1',
              direction: 'inbound',
              fromNumber: '+917607185834',
              toNumber: '+917969007408',
              agent: { name: 'Vinod Medical Store Order Assistant' },
            }
          : options.call,
      ),
    },
  };
  const calendar = {
    execute: vi.fn(
      async () =>
        options.result ?? {
          success: true,
          result: { event_id: 'ev1', html_link: 'https://cal/ev1' },
        },
    ),
  };
  const controller = new LiveKitRemindersController(prisma as never, calendar as never);
  return { controller, prisma, calendar };
}

const REQUEST = {
  callId: 'call-1',
  agentId: 'agent-1',
  when_iso: '2026-09-03T10:00:00+05:30',
  title: 'Call back about Corex-DX price',
  notes: 'Caller wants the price before ordering.',
  timezone: 'Asia/Kolkata',
};

describe('LiveKitRemindersController', () => {
  it('books a 30-minute event on the primary calendar, titled with the agent, idempotent per call and time', async () => {
    const { controller, calendar } = makeController();

    await expect(controller.schedule(REQUEST)).resolves.toEqual({
      scheduled: true,
      reason: null,
      event_link: 'https://cal/ev1',
    });

    expect(calendar.execute).toHaveBeenCalledWith(
      {
        operation: 'create_event',
        summary: 'Vinod Medical Store Order Assistant: Call back about Corex-DX price',
        start_iso: '2026-09-03T04:30:00.000Z',
        end_iso: '2026-09-03T05:00:00.000Z',
        time_zone: 'Asia/Kolkata',
        description: 'Caller wants the price before ordering.\nCaller: +917607185834\nCall: call-1',
      },
      { calendar_id: 'primary' },
      { workspaceId: 'ws-1', idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/) },
    );
    // Same call, same time → same key, so a retried tool call replays instead of double-booking.
    const first = (calendar.execute.mock.calls[0] as unknown[])[2] as { idempotencyKey: string };
    await controller.schedule(REQUEST);
    const second = (calendar.execute.mock.calls[1] as unknown[])[2] as { idempotencyKey: string };
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('reports a calendar failure as not scheduled instead of throwing', async () => {
    const { controller } = makeController({
      result: { success: false, error: 'Google reauth required' },
    });

    await expect(controller.schedule(REQUEST)).resolves.toEqual({
      scheduled: false,
      reason: 'Google reauth required',
      event_link: null,
    });
  });

  it('refuses a call that is not bound to the agent', async () => {
    const { controller, calendar } = makeController({
      call: {
        id: 'call-1',
        workspaceId: 'ws-1',
        agentId: 'agent-2',
        direction: 'inbound',
        fromNumber: null,
        toNumber: null,
        agent: { name: 'x' },
      },
    });

    await expect(controller.schedule(REQUEST)).rejects.toMatchObject({ status: 403 });
    expect(calendar.execute).not.toHaveBeenCalled();
  });
});
