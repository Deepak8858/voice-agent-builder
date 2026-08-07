import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EmailService } from './email.service';

const envMock = vi.hoisted(() => ({
  env: {
    RESEND_API_KEY: 'test-resend-key' as string | undefined,
    EMAIL_FROM: 'VoiceForge <noreply@voiceforge.test>' as string | undefined,
    WEB_BASE_URL: 'https://app.voiceforge.test' as string | undefined,
  },
}));

vi.mock('../config/env', () => ({
  env: envMock.env,
  isProduction: () => false,
}));

type Membership = { role: string; user: { email: string | null } | null };

interface SentPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Typed accessor for the JSON body of a recorded fetch call. */
function sentPayload(fetchSpy: FetchSpy, index = 0): SentPayload {
  const call = fetchSpy.mock.calls[index];
  if (!call) throw new Error(`no fetch call recorded at index ${index}`);
  return JSON.parse(call[1].body as string) as SentPayload;
}

function sentHeaders(fetchSpy: FetchSpy, index = 0): Record<string, string> {
  const call = fetchSpy.mock.calls[index];
  if (!call) throw new Error(`no fetch call recorded at index ${index}`);
  return call[1].headers as Record<string, string>;
}

type FetchSpy = ReturnType<typeof makeFetchSpy>;

function makeFetchSpy(...responses: Response[]) {
  const spy = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift();
    return next ?? okResponse();
  });
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return spy;
}

function okResponse() {
  return new Response('{}', { status: 200 });
}

function makeService(options: {
  workspace?: { id: string; name: string } | null;
  memberships?: Membership[];
  calls?: Array<{ durationSeconds: number | null }>;
  complianceBlocked?: Array<{ reasons: Array<{ code: string }> }>;
  campaigns?: Array<{ name: string; contacts: unknown[] }>;
} = {}) {
  const prisma = {
    workspace: {
      findUnique: vi.fn(async () =>
        options.workspace === undefined ? { id: 'ws-1', name: 'Acme Dental' } : options.workspace,
      ),
    },
    membership: {
      findMany: vi.fn(async (_args?: unknown): Promise<Membership[]> =>
        options.memberships ?? [{ role: 'owner', user: { email: 'owner@acme.test' } }],
      ),
    },
    call: {
      findMany: vi.fn(async () => options.calls ?? []),
    },
    complianceCheck: {
      findMany: vi.fn(async () => options.complianceBlocked ?? []),
    },
    outboundCampaign: {
      findMany: vi.fn(async () => options.campaigns ?? []),
    },
  };

  return { prisma, service: new EmailService(prisma as never) };
}

describe('EmailService.sendWeeklyDigest', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env.RESEND_API_KEY = 'test-resend-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends a digest containing the real computed stats to every owner and admin', async () => {
    const fetchSpy = makeFetchSpy();

    const { service, prisma } = makeService({
      memberships: [
        { role: 'owner', user: { email: 'owner@acme.test' } },
        { role: 'admin', user: { email: 'admin@acme.test' } },
      ],
      // 120s + 60s = 3 minutes across 2 calls.
      calls: [{ durationSeconds: 120 }, { durationSeconds: 60 }],
      complianceBlocked: [
        { reasons: [{ code: 'dnc_listed' }] },
        { reasons: [{ code: 'dnc_listed' }] },
      ],
      campaigns: [{ name: 'Spring Recall', contacts: [{}, {}, {}] }],
    });

    const result = await service.sendWeeklyDigest('ws-1');

    expect(result).toEqual({ status: 'sent', sent: 2, failed: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect([sentPayload(fetchSpy, 0).to, sentPayload(fetchSpy, 1).to]).toEqual([
      'owner@acme.test',
      'admin@acme.test',
    ]);

    const payload = sentPayload(fetchSpy);
    expect(payload.subject).toBe('VoiceForge weekly digest — Acme Dental');

    // Stats must be rendered, not merely computed.
    expect(payload.html).toContain('Acme Dental');
    expect(payload.html).toContain('>2<'); // total calls
    expect(payload.html).toContain('3.0'); // total minutes
    expect(payload.html).toContain('dnc_listed');
    expect(payload.html).toContain('Spring Recall');

    expect(payload.text).toContain('Calls: 2');
    expect(payload.text).toContain('Minutes: 3.0');
    expect(payload.text).toContain('Avg duration: 1.5 min');
    expect(payload.text).toContain('dnc_listed: 2');
    expect(payload.text).toContain('Spring Recall: 3 scheduled calls');

    // Blocked rate = 2 blocked / (2 calls + 2 blocked) = 50%.
    expect(payload.text).toContain('Blocked rate: 50.0%');

    expect(prisma.call.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws-1' }) }),
    );
  });

  it('skips without sending when RESEND_API_KEY is not configured', async () => {
    const fetchSpy = makeFetchSpy();
    envMock.env.RESEND_API_KEY = undefined;

    const { service, prisma } = makeService();

    const result = await service.sendWeeklyDigest('ws-1');

    expect(result).toEqual({
      status: 'skipped',
      reason: 'email_not_configured',
      sent: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Must short-circuit before doing any digest work.
    expect(prisma.call.findMany).not.toHaveBeenCalled();
  });

  it('skips when the workspace does not exist', async () => {
    const fetchSpy = makeFetchSpy();

    const { service, prisma } = makeService({ workspace: null });

    const result = await service.sendWeeklyDigest('ws-missing');

    expect(result).toEqual({
      status: 'skipped',
      reason: 'workspace_not_found',
      sent: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.membership.findMany).not.toHaveBeenCalled();
  });

  it('skips when the workspace has no owner/admin recipients', async () => {
    const fetchSpy = makeFetchSpy();

    const { service, prisma } = makeService({ memberships: [] });

    const result = await service.sendWeeklyDigest('ws-1');

    expect(result).toEqual({ status: 'skipped', reason: 'no_recipients', sent: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.call.findMany).not.toHaveBeenCalled();
  });

  it('only queries owner/admin memberships of the requested workspace', async () => {
    makeFetchSpy();

    const { service, prisma } = makeService();
    await service.sendWeeklyDigest('ws-1');

    expect(prisma.membership.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', role: { in: ['owner', 'admin'] } },
      select: { user: { select: { email: true } } },
    });
  });

  it('does not send to members of a different workspace', async () => {
    const fetchSpy = makeFetchSpy();

    const { service, prisma } = makeService();
    // Simulate a correctly-scoped query: the other tenant's owner is not returned.
    prisma.membership.findMany.mockImplementation(async (args?: unknown) => {
      const { where } = args as { where: { workspaceId: string } };
      return where.workspaceId === 'ws-1'
        ? [{ role: 'owner', user: { email: 'owner@acme.test' } }]
        : [{ role: 'owner', user: { email: 'owner@other-tenant.test' } }];
    });

    await service.sendWeeklyDigest('ws-1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentPayload(fetchSpy).to).toBe('owner@acme.test');
  });

  it('ignores members without an email and de-duplicates repeated addresses', async () => {
    const fetchSpy = makeFetchSpy();

    const { service } = makeService({
      memberships: [
        { role: 'owner', user: { email: 'owner@acme.test' } },
        { role: 'admin', user: { email: 'OWNER@acme.test' } },
        { role: 'admin', user: { email: '   ' } },
        { role: 'admin', user: { email: null } },
        { role: 'admin', user: null },
      ],
    });

    const result = await service.sendWeeklyDigest('ws-1');

    expect(result).toEqual({ status: 'sent', sent: 1, failed: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the provider rejects, and still delivers to other recipients', async () => {
    const fetchSpy = makeFetchSpy(
      new Response('rejected by provider', { status: 422 }),
      okResponse(),
    );

    const { service } = makeService({
      memberships: [
        { role: 'owner', user: { email: 'owner@acme.test' } },
        { role: 'admin', user: { email: 'admin@acme.test' } },
      ],
    });

    const result = await service.sendWeeklyDigest('ws-1');

    expect(result).toEqual({ status: 'sent', sent: 1, failed: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the provider request fails at the network level', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof globalThis.fetch;

    const { service } = makeService();

    await expect(service.sendWeeklyDigest('ws-1')).resolves.toEqual({
      status: 'sent',
      sent: 0,
      failed: 1,
    });
  });

  it('escapes HTML in workspace and campaign names so digests cannot inject markup', async () => {
    const fetchSpy = makeFetchSpy();

    const { service } = makeService({
      workspace: { id: 'ws-1', name: '<script>alert(1)</script>' },
      campaigns: [{ name: '<img src=x onerror=1>', contacts: [] }],
    });

    await service.sendWeeklyDigest('ws-1');

    const payload = sentPayload(fetchSpy);
    expect(payload.html).not.toContain('<script>');
    expect(payload.html).toContain('&lt;script&gt;');
    expect(payload.html).not.toContain('<img src=x');
    expect(payload.html).toContain('&lt;img src=x onerror=1&gt;');
  });

  it('renders empty-state copy when there is no activity', async () => {
    const fetchSpy = makeFetchSpy();

    const { service } = makeService();

    await service.sendWeeklyDigest('ws-1');

    const payload = sentPayload(fetchSpy);
    expect(payload.text).toContain('Calls: 0');
    expect(payload.text).toContain('Blocked rate: 0.0%');
    expect(payload.text).toContain('No compliance blocks this week.');
    expect(payload.text).toContain('No active or draft campaigns.');
  });

  it('never embeds the Resend API key in the message body', async () => {
    const fetchSpy = makeFetchSpy();

    const { service } = makeService();
    await service.sendWeeklyDigest('ws-1');

    const payload = sentPayload(fetchSpy);
    expect(payload.html).not.toContain('test-resend-key');
    expect(payload.text).not.toContain('test-resend-key');
    // The key belongs in the Authorization header only.
    expect(sentHeaders(fetchSpy).Authorization).toBe('Bearer test-resend-key');
  });
});
