import { describe, expect, it, vi } from 'vitest';
import { createReminderClient, createReminderTool } from './reminders';

function execute(
  schedule = vi.fn(async () => ({ scheduled: true, reason: null, event_link: 'https://cal/ev1' })),
) {
  const tool = createReminderTool({ agentId: 'agent-1', callId: 'call-1', schedule });
  const run = (tool as unknown as { execute: (args: unknown, opts: unknown) => Promise<unknown> })
    .execute;
  return { run, schedule };
}

describe('schedule_reminder tool', () => {
  it('books through the API and tells the model to confirm the time', async () => {
    const { run, schedule } = execute();

    await expect(
      run(
        {
          when_iso: '2026-09-03T10:00:00+05:30',
          title: 'Call back',
          notes: 'Price check',
          timezone: 'Asia/Kolkata',
        },
        {},
      ),
    ).resolves.toMatchObject({ scheduled: true });
    expect(schedule).toHaveBeenCalledWith({
      callId: 'call-1',
      agentId: 'agent-1',
      when_iso: '2026-09-03T10:00:00+05:30',
      title: 'Call back',
      notes: 'Price check',
      timezone: 'Asia/Kolkata',
    });
  });

  it('asks for the time again when the date cannot be parsed, without calling the API', async () => {
    const { run, schedule } = execute();

    await expect(
      run({ when_iso: 'tomorrow morning', title: 'Call back' }, {}),
    ).resolves.toMatchObject({
      scheduled: false,
      instruction: expect.stringContaining('exact day and time'),
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it('never throws into the turn: API failures become an apology instruction', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { run } = execute(
      vi.fn(async () => {
        throw new Error('502');
      }) as never,
    );

    await expect(run({ when_iso: '2026-09-03T10:00:00Z', title: 'x' }, {})).resolves.toMatchObject({
      scheduled: false,
      instruction: expect.stringContaining('could not be booked'),
    });
    warn.mockRestore();
  });
});

describe('reminder client', () => {
  it('posts to the internal reminders route with the internal key', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { scheduled: true, reason: null, event_link: null },
          }),
          {
            status: 200,
          },
        ),
    );
    const schedule = createReminderClient({
      apiBaseUrl: 'http://api.internal',
      internalApiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      schedule({
        callId: 'call-1',
        agentId: 'agent-1',
        when_iso: '2026-09-03T10:00:00Z',
        title: 'x',
      }),
    ).resolves.toEqual({ scheduled: true, reason: null, event_link: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.internal/api/v1/internal/runtime/reminders');
    expect((init.headers as Record<string, string>)['x-internal-key']).toBe('secret');
  });
});
