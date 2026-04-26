import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ToolsService } from './tools.service';
import {
  ToolExecutionFailedError,
  ToolInputInvalidError,
  ToolNotFoundError,
} from '../common/errors';

interface ToolRow {
  id: string;
  workspaceId: string;
  agentId: string | null;
  name: string;
  description: string;
  toolType: string;
  config: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface InvocationRow {
  id: string;
  workspaceId: string;
  toolId: string;
  agentId: string | null;
  callId: string | null;
  status: string;
  responseStatus: number | null;
  responseBody: Prisma.JsonValue | null;
  durationMs: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  errorMessage: string | null;
  requestPayload: Prisma.JsonValue;
}

function makeService(opts: { tool?: ToolRow | null }) {
  let invCounter = 0;
  const invocations = new Map<string, InvocationRow>();
  const prisma = {
    integrationTool: {
      findFirst: vi.fn(async () => opts.tool ?? null),
    },
    toolInvocation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        invCounter += 1;
        const row: InvocationRow = {
          id: `inv_${invCounter}`,
          workspaceId: data.workspaceId as string,
          toolId: data.toolId as string,
          agentId: (data.agentId as string | null) ?? null,
          callId: (data.callId as string | null) ?? null,
          status: data.status as string,
          responseStatus: null,
          responseBody: null,
          durationMs: null,
          startedAt: new Date('2026-04-26T10:00:00Z'),
          finishedAt: null,
          errorMessage: null,
          requestPayload: (data.requestPayload as Prisma.JsonValue | undefined) ?? null,
        };
        invocations.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = invocations.get(where.id);
        if (!existing) throw new Error('not found');
        const updated = { ...existing, ...data } as InvocationRow;
        invocations.set(where.id, updated);
        return updated;
      }),
    },
  };
  const audit = { log: vi.fn() };
  const executor = {
    execute: vi.fn(),
  };
  const service = new ToolsService(prisma as never, audit as never, executor as never);
  return { service, prisma, audit, executor, invocations };
}

const baseTool: ToolRow = {
  id: 'tool_1',
  workspaceId: 'w1',
  agentId: null,
  name: 'create_booking',
  description: 'Webhook',
  toolType: 'webhook',
  config: { url: 'https://example.test/x', method: 'POST' },
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ToolsService.invoke', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws ToolNotFoundError when tool missing', async () => {
    const { service } = makeService({ tool: null });
    await expect(
      service.invoke('w1', 'missing', 'u1', { arguments: {} }),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it('throws ToolExecutionFailedError when tool disabled', async () => {
    const { service } = makeService({ tool: { ...baseTool, enabled: false } });
    await expect(
      service.invoke('w1', 'tool_1', 'u1', { arguments: { name: 'a' } }),
    ).rejects.toBeInstanceOf(ToolExecutionFailedError);
  });

  it('rejects invalid input against schema', async () => {
    const { service, executor } = makeService({ tool: baseTool });
    await expect(
      service.invoke('w1', 'tool_1', 'u1', { arguments: {} }),
    ).rejects.toBeInstanceOf(ToolInputInvalidError);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('marks invocation success on 2xx response', async () => {
    const { service, executor, invocations } = makeService({ tool: baseTool });
    executor.execute.mockResolvedValue({ status: 200, body: { ok: true }, duration_ms: 42 });
    const result = await service.invoke('w1', 'tool_1', 'u1', { arguments: { name: 'Ada' } });
    expect(result.status).toBe('success');
    expect(result.response_status).toBe(200);
    expect(result.duration_ms).toBe(42);
    const stored = [...invocations.values()][0]!;
    expect(stored.status).toBe('success');
    expect(stored.responseBody).toEqual({ ok: true });
    expect(stored.errorMessage).toBeNull();
  });

  it('marks invocation failed on non-2xx response', async () => {
    const { service, executor } = makeService({ tool: baseTool });
    executor.execute.mockResolvedValue({ status: 500, body: { err: 'boom' }, duration_ms: 10 });
    const result = await service.invoke('w1', 'tool_1', 'u1', { arguments: { name: 'Ada' } });
    expect(result.status).toBe('failed');
    expect(result.response_status).toBe(500);
    expect(result.error_message).toBe('HTTP 500');
  });

  it('captures executor exception as failed invocation and rethrows', async () => {
    const { service, executor, invocations } = makeService({ tool: baseTool });
    executor.execute.mockRejectedValue(new Error('network down'));
    await expect(
      service.invoke('w1', 'tool_1', 'u1', { arguments: { name: 'Ada' } }),
    ).rejects.toBeInstanceOf(ToolExecutionFailedError);
    const stored = [...invocations.values()][0]!;
    expect(stored.status).toBe('failed');
    expect(stored.errorMessage).toBe('network down');
    expect(stored.finishedAt).not.toBeNull();
  });

  it('rejects unsupported tool_type as failed invocation', async () => {
    const { service, executor, invocations } = makeService({
      tool: { ...baseTool, toolType: 'google_calendar' },
    });
    await expect(
      service.invoke('w1', 'tool_1', 'u1', { arguments: { name: 'Ada' } }),
    ).rejects.toBeInstanceOf(ToolExecutionFailedError);
    expect(executor.execute).not.toHaveBeenCalled();
    const stored = [...invocations.values()][0]!;
    expect(stored.status).toBe('failed');
  });
});

describe('ToolsService.toDetail', () => {
  it('hides hmac_secret in response payload', async () => {
    const { service } = makeService({
      tool: { ...baseTool, config: { url: 'https://x', method: 'POST', hmac_secret: 'sek' } },
    });
    const detail = await service.get('w1', 'tool_1');
    expect((detail.config as { hmac_secret_set: boolean }).hmac_secret_set).toBe(true);
    expect((detail.config as Record<string, unknown>).hmac_secret).toBeUndefined();
  });
});
