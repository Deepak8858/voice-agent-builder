import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import { safeFetch } from '../common/safe-fetch';
import { AgentSheetService, columnLetter } from './agent-sheet.service';

vi.mock('../common/safe-fetch', () => ({ safeFetch: vi.fn() }));

const spec = {
  required_fields: [
    { key: 'full_name', type: 'string', required: true },
    { key: 'medicine_name', type: 'string', required: true },
  ],
} as unknown as AgentSpec;

const agent = {
  id: 'agent-1',
  workspaceId: 'ws-1',
  organizationId: 'org-1',
  name: 'Vinod Medical Store',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeService(
  options: {
    resource?: Record<string, unknown> | null;
    call?: Record<string, unknown> | null;
  } = {},
) {
  const prisma = {
    agentGoogleResource: {
      findFirst: vi.fn(async () => options.resource ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'res-1',
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'res-1',
        ...data,
      })),
    },
    call: {
      findUnique: vi.fn(async () => options.call ?? null),
      findFirst: vi.fn(async () => options.call ?? null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'call-1',
        ...data,
      })),
    },
    $executeRaw: vi.fn(async () => 1),
  };
  const google = {
    getStatus: vi.fn(async () => ({
      connected: true,
      status: 'connected',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })),
    getUsableAccessToken: vi.fn(async () => 'token'),
  };
  const queue = { enqueue: vi.fn(async () => undefined) };
  const service = new AgentSheetService(prisma as never, google as never, queue as never);
  return { service, prisma, google, queue };
}

const fetchCalls = () =>
  vi.mocked(safeFetch).mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit)?.method,
    body: (init as RequestInit)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
  }));

describe('AgentSheetService.ensureForPublish', () => {
  beforeEach(() => vi.mocked(safeFetch).mockReset());

  it('creates the spreadsheet once, named after the agent, with fixed columns then the field keys verbatim', async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(
        json({
          spreadsheetId: 'SS1',
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SS1',
        }),
      )
      .mockResolvedValueOnce(json({}));
    const { service, prisma } = makeService();

    const result = await service.ensureForPublish(agent, spec);

    expect(result).toEqual({ spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SS1' });
    const [create, header] = fetchCalls();
    expect(create.method).toBe('POST');
    expect(create.body).toEqual({
      properties: { title: 'Vinod Medical Store' },
      sheets: [{ properties: { title: 'Calls' } }],
    });
    expect(header.url).toContain(`/values/${encodeURIComponent('Calls!A1')}`);
    expect(header.body).toEqual({
      values: [['Call time', 'Caller number', 'Call ID', 'Outcome', 'full_name', 'medicine_name']],
    });
    // The row exists before the first Google write after creation, so a
    // failed header write can never strand the spreadsheet.
    expect(prisma.agentGoogleResource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        spreadsheetId: 'SS1',
        status: 'pending',
        columns: [],
      }),
    });
    expect(prisma.agentGoogleResource.create.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(safeFetch).mock.invocationCallOrder[1],
    );
    expect(prisma.agentGoogleResource.update).toHaveBeenCalledWith({
      where: { id: 'res-1' },
      data: expect.objectContaining({
        status: 'ready',
        columns: [
          { key: 'call_time', header: 'Call time' },
          { key: 'caller_number', header: 'Caller number' },
          { key: 'call_id', header: 'Call ID' },
          { key: 'outcome', header: 'Outcome' },
          { key: 'full_name', header: 'full_name' },
          { key: 'medicine_name', header: 'medicine_name' },
        ],
      }),
    });
  });

  it('records a failed first header write on the row instead of orphaning the spreadsheet', async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(json({ spreadsheetId: 'SS1', spreadsheetUrl: 'u' }))
      .mockResolvedValueOnce(json({ error: { message: 'quota' } }, 429));
    const { service, prisma } = makeService();

    await expect(service.ensureForPublish(agent, spec)).resolves.toBeNull();

    expect(prisma.agentGoogleResource.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentGoogleResource.update).toHaveBeenLastCalledWith({
      where: { id: 'res-1' },
      data: { status: 'error', lastError: expect.stringContaining('429') },
    });
  });

  // Rows already written stay aligned: a new field becomes a new column on the
  // right, and nothing existing moves.
  it('appends headers for new fields on a later publish and never reorders existing columns', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(json({}));
    const existingColumns = [
      { key: 'call_time', header: 'Call time' },
      { key: 'caller_number', header: 'Caller number' },
      { key: 'call_id', header: 'Call ID' },
      { key: 'outcome', header: 'Outcome' },
      { key: 'full_name', header: 'full_name' },
    ];
    const { service, prisma } = makeService({
      resource: {
        id: 'res-1',
        spreadsheetId: 'SS1',
        spreadsheetUrl: 'u',
        sheetTitle: 'Calls',
        columns: existingColumns,
      },
    });

    await service.ensureForPublish(agent, spec);

    const [header] = fetchCalls();
    expect(header.method).toBe('PUT');
    expect(header.url).toContain(`/values/${encodeURIComponent('Calls!F1')}`);
    expect(header.body).toEqual({ values: [['medicine_name']] });
    expect(prisma.agentGoogleResource.update).toHaveBeenCalledWith({
      where: { id: 'res-1' },
      data: expect.objectContaining({
        columns: [...existingColumns, { key: 'medicine_name', header: 'medicine_name' }],
        status: 'ready',
      }),
    });
  });

  it('does nothing when Google is not connected with the spreadsheets scope', async () => {
    const { service, google } = makeService();
    google.getStatus.mockResolvedValueOnce({
      connected: true,
      status: 'connected',
      scopes: ['openid'],
    });

    await expect(service.ensureForPublish(agent, spec)).resolves.toBeNull();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('never fails the publish: a Google error is recorded on the resource', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(json({ error: { message: 'quota' } }, 429));
    const { service, prisma } = makeService({
      resource: {
        id: 'res-1',
        spreadsheetId: 'SS1',
        spreadsheetUrl: 'u',
        sheetTitle: 'Calls',
        columns: [],
      },
    });

    await expect(service.ensureForPublish(agent, spec)).resolves.toBeNull();
    expect(prisma.agentGoogleResource.update).toHaveBeenLastCalledWith({
      where: { id: 'res-1' },
      data: { status: 'error', lastError: expect.stringContaining('429') },
    });
  });
});

describe('AgentSheetService.recordCallerDetails', () => {
  beforeEach(() => vi.mocked(safeFetch).mockReset());

  it('merges known fields onto the call and queues the row write without touching Google', async () => {
    const { service, prisma, queue } = makeService({
      call: {
        id: 'call-1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        metadata: { caller_details: { full_name: 'Deepak' } },
      },
      resource: {
        columns: [
          { key: 'full_name', header: 'full_name' },
          { key: 'medicine_name', header: 'medicine_name' },
        ],
      },
    });

    const result = await service.recordCallerDetails({
      callId: 'call-1',
      agentId: 'agent-1',
      fields: { medicine_name: ' Corex ', unknown_field: 'x', full_name: null },
    });

    expect(result).toEqual({ saved: true, reason: null });
    // An in-database JSON merge of only the accepted fields; never a whole-object write.
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = prisma.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(sql.join('?')).toContain("'{caller_details}'");
    expect(values).toEqual([JSON.stringify({ medicine_name: 'Corex' }), 'call-1']);
    expect(queue.enqueue).toHaveBeenCalledWith(
      'agent_sheet_sync',
      'sync',
      { callId: 'call-1', workspaceId: 'ws-1' },
      expect.objectContaining({ attempts: 3, removeOnComplete: true }),
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('refuses a call that is not bound to the agent', async () => {
    const { service } = makeService({
      call: { id: 'call-1', workspaceId: 'ws-1', agentId: 'agent-2', metadata: null },
    });

    await expect(
      service.recordCallerDetails({
        callId: 'call-1',
        agentId: 'agent-1',
        fields: { full_name: 'x' },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('reports no sheet instead of failing when the agent has none', async () => {
    const { service, queue } = makeService({
      call: { id: 'call-1', workspaceId: 'ws-1', agentId: 'agent-1', metadata: null },
      resource: null,
    });

    await expect(
      service.recordCallerDetails({
        callId: 'call-1',
        agentId: 'agent-1',
        fields: { full_name: 'x' },
      }),
    ).resolves.toEqual({ saved: false, reason: 'no_sheet' });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe('AgentSheetService.syncCallRow', () => {
  beforeEach(() => vi.mocked(safeFetch).mockReset());

  const resource = {
    spreadsheetId: 'SS1',
    sheetTitle: 'Calls',
    columns: [
      { key: 'call_time', header: 'Call time' },
      { key: 'caller_number', header: 'Caller number' },
      { key: 'call_id', header: 'Call ID' },
      { key: 'outcome', header: 'Outcome' },
      { key: 'full_name', header: 'full_name' },
      { key: 'medicine_name', header: 'medicine_name' },
    ],
  };
  const call = {
    id: 'call-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    direction: 'inbound',
    fromNumber: '+917607185834',
    toNumber: '+917969007408',
    status: 'in_progress',
    outcome: null,
    startedAt: new Date('2026-09-02T15:00:00.000Z'),
    createdAt: new Date('2026-09-02T14:59:58.000Z'),
    metadata: { caller_details: { full_name: 'Deepak' } },
  };

  it('appends the first row for a call and remembers its row number', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(json({ updates: { updatedRange: 'Calls!A7:F7' } }));
    const { service, prisma } = makeService({ call, resource });

    await service.syncCallRow({ callId: 'call-1', workspaceId: 'ws-1' });

    const [append] = fetchCalls();
    expect(append.url).toContain(':append');
    expect(append.body).toEqual({
      values: [
        ['2026-09-02T15:00:00.000Z', '+917607185834', 'call-1', 'in_progress', 'Deepak', ''],
      ],
    });
    // Only sheet_row is merged in, atomically; details saved meanwhile survive.
    expect(prisma.call.update).not.toHaveBeenCalled();
    const [sql, ...values] = prisma.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(sql.join('?')).toContain("'{sheet_row}'");
    expect(values).toEqual([7, 'call-1', 'ws-1']);
  });

  it('updates the same row on later saves and at call end', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(json({}));
    const { service, prisma } = makeService({
      call: {
        ...call,
        direction: 'outbound',
        status: 'completed',
        outcome: 'completed',
        metadata: { caller_details: { full_name: 'Deepak', medicine_name: 'Corex' }, sheet_row: 7 },
      },
      resource,
    });

    await service.syncCallRow({ callId: 'call-1', workspaceId: 'ws-1' });

    const [update] = fetchCalls();
    expect(update.method).toBe('PUT');
    expect(update.url).toContain(`/values/${encodeURIComponent('Calls!A7')}`);
    expect(update.body).toEqual({
      values: [
        ['2026-09-02T15:00:00.000Z', '+917969007408', 'call-1', 'completed', 'Deepak', 'Corex'],
      ],
    });
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('columnLetter', () => {
  it('maps 0-based indexes to sheet letters, including beyond Z', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(5)).toBe('F');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
  });
});
