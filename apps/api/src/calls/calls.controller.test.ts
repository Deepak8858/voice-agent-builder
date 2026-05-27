import { describe, expect, it, vi } from 'vitest';
import { CallsController } from './calls.controller';

describe('CallsController.live', () => {
  it('streams live call events through the injected cache service', async () => {
    const calls = {
      getLiveEvents: vi.fn(async () => [{ type: 'call.started', call_id: 'call-1' }]),
    };
    const cache = {
      subscribe: vi.fn(() =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      ),
    };
    const response = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };

    const controller = new CallsController(calls as never, cache as never);
    await controller.live('ws-1', 'call-1', response as never);

    expect(cache.subscribe).toHaveBeenCalledWith('call:call-1');
    expect(response.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ type: 'call.started', call_id: 'call-1' })}\n\n`,
    );
    expect(response.end).toHaveBeenCalled();
  });
});
