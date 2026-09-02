import { describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import type { z } from 'zod';
import { createCallerDetailsClient, createCallerDetailsTool } from './caller-details';

const spec = {
  required_fields: [
    { key: 'full_name', type: 'string', required: true, description: 'Caller full name' },
    { key: 'phone', type: 'phone', required: true },
    { key: 'medicine_name', type: 'string', required: true },
    { key: 'not_in_sheet', type: 'string', required: false },
  ],
} as unknown as AgentSpec;

const columns = [
  'call_time',
  'caller_number',
  'call_id',
  'outcome',
  'full_name',
  'phone',
  'medicine_name',
];

function makeTool(save = vi.fn(async () => ({ saved: true, reason: null }))) {
  const tool = createCallerDetailsTool({
    spec,
    agentId: 'agent-1',
    callId: 'call-1',
    sheetColumns: columns,
    save,
  });
  if (!tool) throw new Error('tool not created');
  const t = tool as unknown as {
    parameters: z.ZodObject<z.ZodRawShape>;
    execute: (args: unknown, opts: unknown) => Promise<unknown>;
  };
  return { t, save };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('save_caller_details tool', () => {
  it('exposes one optional parameter per required field that has a sheet column', () => {
    const { t } = makeTool();
    expect(Object.keys(t.parameters.shape)).toEqual(['full_name', 'phone', 'medicine_name']);
    expect(t.parameters.safeParse({ full_name: 'Deepak' }).success).toBe(true);
    expect(t.parameters.safeParse({}).success).toBe(true);
  });

  it('is not offered when the agent has no fields to capture', () => {
    expect(
      createCallerDetailsTool({
        spec: { required_fields: [] } as unknown as AgentSpec,
        agentId: 'agent-1',
        callId: 'call-1',
        sheetColumns: columns,
        save: vi.fn(),
      }),
    ).toBeNull();
  });

  // The conversation must never wait on Google: the tool answers before the
  // API is even reached, and saves arrive at the API in the order made.
  it('returns immediately and posts saves in order, dropping empty fields', async () => {
    const order: string[] = [];
    const save = vi.fn(async (input: { fields: Record<string, string> }) => {
      order.push(Object.values(input.fields).join(','));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { saved: true, reason: null };
    });
    const { t } = makeTool(save as never);

    const first = await t.execute({ full_name: 'Deepak', phone: null, medicine_name: '' }, {});
    const second = await t.execute({ medicine_name: 'Corex' }, {});

    expect(first).toEqual({ saved: true, fields: ['full_name'] });
    expect(second).toEqual({ saved: true, fields: ['medicine_name'] });
    expect(save).toHaveBeenCalledTimes(1); // second is still queued behind the first
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['Deepak', 'Corex']);
    expect(save).toHaveBeenLastCalledWith({
      callId: 'call-1',
      agentId: 'agent-1',
      fields: { medicine_name: 'Corex' },
    });
  });

  it('does not throw into the turn when the API fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { t } = makeTool(
      vi.fn(async () => {
        throw new Error('boom');
      }) as never,
    );

    await expect(t.execute({ full_name: 'Deepak' }, {})).resolves.toMatchObject({ saved: true });
    await flush();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('save failed for call call-1'));
    warn.mockRestore();
  });

  it('saves nothing when every field is empty', async () => {
    const { t, save } = makeTool();
    await expect(t.execute({ full_name: '' }, {})).resolves.toEqual({
      saved: false,
      reason: 'nothing_to_save',
    });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('caller details client', () => {
  it('posts to the internal route with the internal key', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: { saved: true, reason: null } }), {
          status: 200,
        }),
    );
    const save = createCallerDetailsClient({
      apiBaseUrl: 'http://api.internal/',
      internalApiKey: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      save({ callId: 'call-1', agentId: 'agent-1', fields: { full_name: 'D' } }),
    ).resolves.toEqual({
      saved: true,
      reason: null,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.internal/api/v1/internal/runtime/caller-details');
    expect((init.headers as Record<string, string>)['x-internal-key']).toBe('secret');
  });
});
