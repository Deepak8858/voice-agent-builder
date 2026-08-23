import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ToolsService } from './tools.service';
import {
  ComplianceBlockedError,
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

function makeService(opts: {
  tool?: ToolRow | null;
  toolsAllowed?: boolean;
  emailAllowed?: boolean;
  exportAllowed?: boolean;
  calendarAllowed?: boolean;
}) {
  let invCounter = 0;
  const invocations = new Map<string, InvocationRow>();
  const prisma = {
    organizationIdFor: vi.fn(async () => 'org-1'),
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
  const calendar = {
    name: 'google_calendar',
    execute: vi.fn(),
  };
  const gmail = {
    name: 'gmail',
    execute: vi.fn(),
  };
  const sheets = {
    name: 'google_sheets',
    execute: vi.fn(),
  };
  const crm = {
    createContact: vi.fn(),
  };
  const billing = {
    checkFeatureGate: vi.fn(async () => opts.toolsAllowed ?? true),
  };
  const compliance = {
    checkOutboundEmail: vi.fn(async () =>
      (opts.emailAllowed ?? true)
        ? { allowed: true, reasons: [] }
        : {
            allowed: false,
            reasons: [
              { code: 'opted_out', message: 'Contact opted out.', severity: 'blocking' },
            ],
          },
    ),
    checkCalendarOperation: vi.fn(async () =>
      (opts.calendarAllowed ?? true)
        ? { allowed: true, reasons: [] }
        : {
            allowed: false,
            reasons: [
              { code: 'opted_out', message: 'Contact opted out.', severity: 'blocking' },
            ],
          },
    ),
    checkDataExport: vi.fn(async () =>
      (opts.exportAllowed ?? true)
        ? { allowed: true, reasons: [] }
        : {
            allowed: false,
            reasons: [
              { code: 'opted_out', message: 'Contact opted out.', severity: 'blocking' },
            ],
          },
    ),
  };
  const service = new ToolsService(
    prisma as never,
    audit as never,
    executor as never,
    calendar as never,
    gmail as never,
    sheets as never,
    crm as never,
    billing as never,
    compliance as never,
  );
  return {
    service,
    prisma,
    audit,
    executor,
    calendar,
    gmail,
    sheets,
    crm,
    billing,
    compliance,
    invocations,
  };
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

  it('blocks tool invocation on free plans', async () => {
    const { service, executor } = makeService({ tool: baseTool, toolsAllowed: false });
    await expect(
      service.invoke('w1', 'tool_1', 'u1', { arguments: { name: 'Ada' } }),
    ).rejects.toThrow(/paid plan/);
    expect(executor.execute).not.toHaveBeenCalled();
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
    executor.execute.mockResolvedValue({
      success: true,
      result: { status: 200, body: { ok: true }, duration_ms: 42 },
    });
    const result = await service.invoke('w1', 'tool_1', 'u1', { arguments: { name: 'Ada' } });
    expect(result.status).toBe('success');
    const stored = [...invocations.values()][0]!;
    expect(stored.status).toBe('success');
    expect(stored.errorMessage).toBeNull();
  });

  it('marks invocation failed on non-2xx response', async () => {
    const { service, executor } = makeService({ tool: baseTool });
    executor.execute.mockResolvedValue({
      success: false,
      error: 'HTTP 500',
      result: { status: 500, body: { err: 'boom' }, duration_ms: 10 },
    });
    const result = await service.invoke('w1', 'tool_1', 'u1', { arguments: { name: 'Ada' } });
    expect(result.status).toBe('failed');
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

  it('invokes the google_calendar executor when configured', async () => {
    const { service, executor, calendar } = makeService({
      tool: {
        ...baseTool,
        toolType: 'google_calendar',
        config: { refresh_token: 'refresh-token', calendar_id: 'primary' },
        inputSchema: {
          type: 'object',
          properties: { operation: { type: 'string' } },
          required: ['operation'],
        },
      },
    });
    calendar.execute.mockResolvedValue({
      success: true,
      result: { eventId: 'evt_1' },
    });
    const result = await service.invoke('w1', 'tool_1', 'u1', {
      arguments: { operation: 'create_event' },
    });
    expect(result.status).toBe('success');
    expect(executor.execute).not.toHaveBeenCalled();
    expect(calendar.execute).toHaveBeenCalledWith(
      { operation: 'create_event' },
      { refresh_token: 'refresh-token', calendar_id: 'primary' },
      { workspaceId: 'w1' },
    );
  });

  it('blocks Calendar operations before executing and audits reason codes only', async () => {
    const calendarTool: ToolRow = {
      ...baseTool,
      toolType: 'google_calendar',
      config: { calendar_id: 'primary' },
      inputSchema: {
        type: 'object',
        properties: { operation: { type: 'string' }, attendees: { type: 'array' } },
        required: ['operation'],
      },
    };
    const { service, calendar, compliance, audit, prisma } = makeService({
      tool: calendarTool,
      calendarAllowed: false,
    });
    await expect(
      service.invoke('w1', 'tool_1', 'u1', {
        arguments: { operation: 'create_event', attendees: ['optout@example.test'] },
      }),
    ).rejects.toBeInstanceOf(ComplianceBlockedError);
    expect(compliance.checkCalendarOperation).toHaveBeenCalledWith(
      'w1',
      'create_event',
      ['optout@example.test'],
    );
    expect(calendar.execute).not.toHaveBeenCalled();
    expect(prisma.toolInvocation.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tool.invoke.blocked',
      metadata: expect.objectContaining({
        tool_type: 'google_calendar',
        reason_codes: ['opted_out'],
      }),
    }));
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('optout@example.test');
  });

  it('allows Calendar reads after evaluating the Calendar compliance gate', async () => {
    const calendarTool: ToolRow = {
      ...baseTool,
      toolType: 'google_calendar',
      config: { calendar_id: 'primary' },
      inputSchema: {
        type: 'object',
        properties: { operation: { type: 'string' } },
        required: ['operation'],
      },
    };
    const { service, calendar, compliance } = makeService({ tool: calendarTool });
    calendar.execute.mockResolvedValue({ success: true, result: { events: [] } });
    await service.invoke('w1', 'tool_1', 'u1', { arguments: { operation: 'list_events' } });
    expect(compliance.checkCalendarOperation).toHaveBeenCalledWith('w1', 'list_events', []);
    expect(calendar.execute).toHaveBeenCalled();
  });

  it('blocks gmail sends to opted-out recipients before executing', async () => {
    const gmailTool: ToolRow = {
      ...baseTool,
      toolType: 'gmail',
      config: { operation: 'send_message' },
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
    };
    const { service, gmail, compliance } = makeService({ tool: gmailTool, emailAllowed: false });
    await expect(
      service.invoke('w1', 'tool_1', 'u1', {
        arguments: { to: 'optout@example.test', subject: 's', body: 'b' },
      }),
    ).rejects.toBeInstanceOf(ComplianceBlockedError);
    expect(compliance.checkOutboundEmail).toHaveBeenCalledWith('w1', 'optout@example.test');
    expect(gmail.execute).not.toHaveBeenCalled();
  });

  it('audits a tool.invoke.blocked event with reason codes only when compliance blocks', async () => {
    const gmailTool: ToolRow = {
      ...baseTool,
      toolType: 'gmail',
      config: { operation: 'send_message' },
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
    };
    const { service, audit, prisma } = makeService({ tool: gmailTool, emailAllowed: false });
    await expect(
      service.invoke('w1', 'tool_1', 'u1', {
        arguments: { to: 'optout@example.test', subject: 's', body: 'b' },
      }),
    ).rejects.toBeInstanceOf(ComplianceBlockedError);
    // No invocation row is created for a blocked call.
    expect(prisma.toolInvocation.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        actorUserId: 'u1',
        action: 'tool.invoke.blocked',
        resourceType: 'integration_tool',
        resourceId: 'tool_1',
        metadata: expect.objectContaining({
          tool_type: 'gmail',
          reason_codes: ['opted_out'],
        }),
      }),
    );
    // The audit payload must never contain the recipient or message content.
    const payload = JSON.stringify(audit.log.mock.calls);
    expect(payload).not.toContain('optout@example.test');
  });

  it('allows gmail sends when the compliance gate passes', async () => {
    const gmailTool: ToolRow = {
      ...baseTool,
      toolType: 'gmail',
      config: { operation: 'send_message' },
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
    };
    const { service, gmail } = makeService({ tool: gmailTool, emailAllowed: true });
    gmail.execute.mockResolvedValue({ success: true, result: { message_id: 'm1' } });
    const result = await service.invoke('w1', 'tool_1', 'u1', {
      arguments: { to: 'ok@example.test', subject: 's', body: 'b' },
    });
    expect(result.status).toBe('success');
    expect(gmail.execute).toHaveBeenCalled();
  });

  it('blocks sheets appends that export opted-out contact data', async () => {
    const sheetsTool: ToolRow = {
      ...baseTool,
      toolType: 'google_sheets',
      config: { operation: 'append_row' },
      inputSchema: {
        type: 'object',
        properties: { values: { type: 'array' } },
        required: ['values'],
      },
    };
    const { service, sheets, compliance, audit } = makeService({
      tool: sheetsTool,
      exportAllowed: false,
    });
    await expect(
      service.invoke('w1', 'tool_1', 'u1', {
        arguments: { values: ['Ada Lovelace', 'optout@example.test', 42] },
      }),
    ).rejects.toBeInstanceOf(ComplianceBlockedError);
    expect(compliance.checkDataExport).toHaveBeenCalledWith('w1', ['optout@example.test']);
    expect(sheets.execute).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tool.invoke.blocked' }),
    );
  });

  it('allows sheets appends when the compliance gate passes', async () => {
    const sheetsTool: ToolRow = {
      ...baseTool,
      toolType: 'google_sheets',
      config: { operation: 'append_row' },
      inputSchema: {
        type: 'object',
        properties: { values: { type: 'array' } },
        required: ['values'],
      },
    };
    const { service, sheets } = makeService({ tool: sheetsTool, exportAllowed: true });
    sheets.execute.mockResolvedValue({ success: true, result: { updated_range: 'A1:C1' } });
    const result = await service.invoke('w1', 'tool_1', 'u1', {
      arguments: { values: ['Ada Lovelace', 'ok@example.test', 42] },
    });
    expect(result.status).toBe('success');
    expect(sheets.execute).toHaveBeenCalled();
  });

  it('invokes the CRM executor when configured', async () => {
    const { service, executor, crm } = makeService({
      tool: {
        ...baseTool,
        toolType: 'crm',
        config: { provider: 'hubspot', api_key: 'hs-key' },
        inputSchema: {
          type: 'object',
          properties: { full_name: { type: 'string' } },
          required: ['full_name'],
        },
      },
    });
    crm.createContact.mockResolvedValue({
      contact_id: 'crm_1',
      status: 'created',
      provider: 'hubspot',
    });

    const result = await service.invoke('w1', 'tool_1', 'u1', {
      arguments: { full_name: 'Ada Lovelace', phone: '+15551234567' },
    });

    expect(result.status).toBe('success');
    expect(executor.execute).not.toHaveBeenCalled();
    expect(crm.createContact).toHaveBeenCalledWith(
      'hubspot',
      { provider: 'hubspot', api_key: 'hs-key' },
      { full_name: 'Ada Lovelace', phone: '+15551234567' },
    );
  });
});

describe('ToolsService.invokeByName', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves a workspace-wide tool by name and invokes it', async () => {
    const { service, executor, prisma } = makeService({ tool: baseTool });
    executor.execute.mockResolvedValue({ success: true, result: { ok: true } });
    const result = await service.invokeByName('w1', 'create_booking', null, {
      arguments: { name: 'Ada' },
    });
    expect(result.status).toBe('success');
    // First lookup is the name-scoped query; agent-less calls only match
    // workspace-wide (agentId null) tools.
    expect(prisma.integrationTool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'w1',
          name: 'create_booking',
          OR: [{ agentId: null }],
        }),
      }),
    );
  });

  it('throws ToolNotFoundError for a missing name', async () => {
    const { service } = makeService({ tool: null });
    await expect(
      service.invokeByName('w1', 'nope', null, { arguments: {} }),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it('includes the requesting agent in the scope filter', async () => {
    const { service, executor, prisma } = makeService({ tool: baseTool });
    executor.execute.mockResolvedValue({ success: true, result: { ok: true } });
    await service.invokeByName('w1', 'create_booking', null, {
      arguments: { name: 'Ada' },
      agent_id: 'agent-1',
    });
    expect(prisma.integrationTool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ agentId: null }, { agentId: 'agent-1' }],
        }),
      }),
    );
  });

  it('scopes the lookup to the declared tool type when provided', async () => {
    const { service, executor, prisma } = makeService({ tool: baseTool });
    executor.execute.mockResolvedValue({ success: true, result: { ok: true } });
    await service.invokeByName(
      'w1',
      'create_booking',
      null,
      { arguments: { name: 'Ada' } },
      'webhook',
    );
    expect(prisma.integrationTool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'w1',
          name: 'create_booking',
          toolType: 'webhook',
        }),
      }),
    );
  });

  it('rejects a same-named tool of a different type than the spec declared', async () => {
    // The mock returns null when the where clause filters out the stored
    // webhook tool, simulating a gmail-declared spec tool matching nothing.
    const { service, prisma } = makeService({ tool: baseTool });
    prisma.integrationTool.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.invokeByName('w1', 'create_booking', null, { arguments: {} }, 'gmail'),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
    expect(prisma.integrationTool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ toolType: 'gmail' }),
      }),
    );
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

  it('returns only the non-secret Google Calendar target config from legacy rows', async () => {
    const { service } = makeService({
      tool: {
        ...baseTool,
        toolType: 'google_calendar',
        config: {
          calendar_id: 'team@example.test',
          refresh_token: 'legacy-refresh-token',
          client_id: 'legacy-client-id',
          client_secret: 'legacy-client-secret',
        },
      },
    });
    const detail = await service.get('w1', 'tool_1');
    expect(detail.config).toEqual({ calendar_id: 'team@example.test' });
    expect(JSON.stringify(detail.config)).not.toContain('legacy-');
  });
});
