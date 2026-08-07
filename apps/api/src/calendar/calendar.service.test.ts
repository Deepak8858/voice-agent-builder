import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarService } from './calendar.service';
import type { RefreshedGoogleToken } from './google-oauth.client';

const HOUR_MS = 60 * 60 * 1000;

interface StoredConfig {
  workspaceId?: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
}

interface EncryptedEnvelope {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Fake encryption that preserves the envelope shape the real EncryptionService
 * produces, so the service's plaintext/ciphertext discrimination is exercised
 * for real rather than stubbed away.
 */
function makeEncryption() {
  return {
    encryptJson: vi.fn(
      (value: unknown): EncryptedEnvelope => ({
        v: 1,
        alg: 'aes-256-gcm',
        iv: 'iv',
        tag: 'tag',
        ciphertext: Buffer.from(JSON.stringify(value)).toString('base64url'),
      }),
    ),
    decryptJson: vi.fn((envelope: unknown): unknown => {
      const { ciphertext } = envelope as EncryptedEnvelope;
      return JSON.parse(Buffer.from(ciphertext, 'base64url').toString('utf8'));
    }),
  };
}

/** Produce the at-rest representation the service writes for a token. */
function sealed(value: string): string {
  return JSON.stringify(makeEncryption().encryptJson(value));
}

function makeFetchSpy() {
  const spy = vi.fn(async (_url: string, _init: RequestInit) => calendarOk());
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return spy;
}

function authHeader(spy: ReturnType<typeof makeFetchSpy>, index = 0): string {
  const call = spy.mock.calls[index];
  if (!call) throw new Error(`no fetch call recorded at index ${index}`);
  return (call[1].headers as Record<string, string>).Authorization ?? '';
}

function calendarOk() {
  return new Response(JSON.stringify({ id: 'evt-1', hangoutLink: 'https://meet.test/abc' }), {
    status: 200,
  });
}

function makeService(config?: StoredConfig | null) {
  const encryption = makeEncryption();
  const prisma = {
    googleCalendarConfig: {
      findUnique: vi.fn(async (args: { where: { workspaceId: string } }) => {
        if (!config) return null;
        if (config.workspaceId && config.workspaceId !== args.where.workspaceId) return null;
        return {
          workspaceId: args.where.workspaceId,
          accessToken: config.accessToken,
          refreshToken: config.refreshToken,
          tokenExpiry: config.tokenExpiry,
        };
      }),
      upsert: vi.fn(async (_args: unknown) => ({})),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
      delete: vi.fn(async (_args: unknown) => ({})),
    },
  };
  const googleOAuth = {
    refreshAccessToken: vi.fn(async (_refreshToken: string): Promise<RefreshedGoogleToken> => {
      throw new Error('refreshAccessToken not stubbed');
    }),
  };

  return {
    prisma,
    encryption,
    googleOAuth,
    service: new CalendarService(prisma as never, encryption as never, googleOAuth as never),
  };
}

/** Typed accessor for the arguments of a recorded updateMany write. */
function writeArgs(
  prisma: ReturnType<typeof makeService>['prisma'],
  index = 0,
): { where: { workspaceId: string }; data: { accessToken: string; refreshToken: string; tokenExpiry: Date } } {
  const call = prisma.googleCalendarConfig.updateMany.mock.calls[index];
  if (!call) throw new Error(`no updateMany call recorded at index ${index}`);
  return call[0] as {
    where: { workspaceId: string };
    data: { accessToken: string; refreshToken: string; tokenExpiry: Date };
  };
}

const bookingArgs = {
  workspaceId: 'ws-1',
  title: 'Cleaning',
  date: '2026-09-01',
  time: '10:30',
  durationMinutes: 30,
};

describe('CalendarService Google token refresh', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses the stored token without refreshing when it is still valid', async () => {
    const fetchSpy = makeFetchSpy();
    const { service, googleOAuth, prisma } = makeService({
      accessToken: sealed('valid-access'),
      refreshToken: sealed('stored-refresh'),
      tokenExpiry: new Date(Date.now() + HOUR_MS),
    });

    const result = await service.bookAppointment(bookingArgs);

    expect(result).toEqual({ eventId: 'evt-1', meetLink: 'https://meet.test/abc' });
    expect(googleOAuth.refreshAccessToken).not.toHaveBeenCalled();
    expect(prisma.googleCalendarConfig.updateMany).not.toHaveBeenCalled();
    expect(authHeader(fetchSpy)).toBe('Bearer valid-access');
  });

  it('refreshes an expired token, uses the new one, and persists it encrypted', async () => {
    const fetchSpy = makeFetchSpy();
    const { service, googleOAuth, prisma, encryption } = makeService({
      accessToken: sealed('stale-access'),
      refreshToken: sealed('stored-refresh'),
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });

    const newExpiry = new Date(Date.now() + HOUR_MS);
    googleOAuth.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-access',
      expiresAt: newExpiry,
    });

    await service.bookAppointment(bookingArgs);

    // The refresh used the decrypted stored refresh token.
    expect(googleOAuth.refreshAccessToken).toHaveBeenCalledWith('stored-refresh');
    // The Calendar API call used the refreshed token, not the stale one.
    expect(authHeader(fetchSpy)).toBe('Bearer fresh-access');

    // Persistence is workspace-scoped and stores ciphertext, not plaintext.
    expect(prisma.googleCalendarConfig.updateMany).toHaveBeenCalledTimes(1);
    const args = writeArgs(prisma);
    expect(args.where).toEqual({ workspaceId: 'ws-1' });
    expect(args.data.tokenExpiry).toEqual(newExpiry);
    expect(args.data.accessToken).not.toContain('fresh-access');
    expect(JSON.parse(args.data.accessToken)).toMatchObject({ v: 1, alg: 'aes-256-gcm' });
    expect(encryption.encryptJson).toHaveBeenCalledWith('fresh-access');
    // Google did not rotate the refresh token, so the original is retained.
    expect(encryption.encryptJson).toHaveBeenCalledWith('stored-refresh');
  });

  it('refreshes proactively when the token expires within the skew window', async () => {
    makeFetchSpy();
    const { service, googleOAuth } = makeService({
      accessToken: sealed('about-to-expire'),
      refreshToken: sealed('stored-refresh'),
      tokenExpiry: new Date(Date.now() + 5_000),
    });
    googleOAuth.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-access',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    await service.bookAppointment(bookingArgs);

    expect(googleOAuth.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('persists a rotated refresh token when Google returns one', async () => {
    makeFetchSpy();
    const { service, googleOAuth, encryption } = makeService({
      accessToken: sealed('stale-access'),
      refreshToken: sealed('old-refresh'),
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });
    googleOAuth.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-access',
      refreshToken: 'rotated-refresh',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    await service.bookAppointment(bookingArgs);

    expect(encryption.encryptJson).toHaveBeenCalledWith('rotated-refresh');
    expect(encryption.encryptJson).not.toHaveBeenCalledWith('old-refresh');
  });

  it('reads legacy plaintext tokens and re-encrypts them on refresh', async () => {
    makeFetchSpy();
    const { service, googleOAuth, encryption } = makeService({
      accessToken: 'legacy-plain-access',
      refreshToken: 'legacy-plain-refresh',
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });
    googleOAuth.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-access',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    await service.bookAppointment(bookingArgs);

    expect(googleOAuth.refreshAccessToken).toHaveBeenCalledWith('legacy-plain-refresh');
    expect(encryption.decryptJson).not.toHaveBeenCalled();
    expect(encryption.encryptJson).toHaveBeenCalledWith('fresh-access');
  });

  it('rejects with a re-connect error when the stored refresh token is missing', async () => {
    const fetchSpy = makeFetchSpy();
    const { service, googleOAuth, prisma } = makeService({
      accessToken: sealed('stale-access'),
      refreshToken: sealed(''),
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });

    await expect(service.bookAppointment(bookingArgs)).rejects.toMatchObject({
      errorCode: 'CRM_NOT_CONFIGURED',
      message: expect.stringContaining('re-connect required'),
    });

    expect(googleOAuth.refreshAccessToken).not.toHaveBeenCalled();
    expect(prisma.googleCalendarConfig.updateMany).not.toHaveBeenCalled();
    // No calendar event may be attempted with an unusable token.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('propagates a provider refresh failure and does not call the Calendar API', async () => {
    const fetchSpy = makeFetchSpy();
    const { service, googleOAuth, prisma } = makeService({
      accessToken: sealed('stale-access'),
      refreshToken: sealed('revoked-refresh'),
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });
    googleOAuth.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(service.bookAppointment(bookingArgs)).rejects.toThrow('invalid_grant');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.googleCalendarConfig.updateMany).not.toHaveBeenCalled();
  });

  it('recovers on a later call after a transient refresh failure', async () => {
    makeFetchSpy();
    const { service, googleOAuth } = makeService({
      accessToken: sealed('stale-access'),
      refreshToken: sealed('stored-refresh'),
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });

    googleOAuth.refreshAccessToken.mockRejectedValueOnce(new Error('network blip'));
    await expect(service.bookAppointment(bookingArgs)).rejects.toThrow('network blip');

    googleOAuth.refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'fresh-access',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
    await expect(service.bookAppointment(bookingArgs)).resolves.toMatchObject({
      eventId: 'evt-1',
    });
    expect(googleOAuth.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into a single token request and single write', async () => {
    makeFetchSpy();
    const { service, googleOAuth, prisma } = makeService({
      accessToken: sealed('stale-access'),
      refreshToken: sealed('stored-refresh'),
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    googleOAuth.refreshAccessToken.mockImplementation(async () => {
      await gate;
      return { accessToken: 'fresh-access', expiresAt: new Date(Date.now() + HOUR_MS) };
    });

    const bookings = Promise.all([
      service.bookAppointment(bookingArgs),
      service.bookAppointment(bookingArgs),
      service.bookAppointment(bookingArgs),
    ]);
    release();
    const results = await bookings;

    expect(results).toHaveLength(3);
    expect(googleOAuth.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(prisma.googleCalendarConfig.updateMany).toHaveBeenCalledTimes(1);
  });

  it('still completes the booking when persisting the refreshed token fails', async () => {
    const fetchSpy = makeFetchSpy();
    const { service, googleOAuth, prisma } = makeService({
      accessToken: sealed('stale-access'),
      refreshToken: sealed('stored-refresh'),
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });
    googleOAuth.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-access',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });
    prisma.googleCalendarConfig.updateMany.mockRejectedValue(new Error('db unavailable'));

    await expect(service.bookAppointment(bookingArgs)).resolves.toMatchObject({
      eventId: 'evt-1',
    });
    expect(authHeader(fetchSpy)).toBe('Bearer fresh-access');
  });

  it('throws when the workspace has no calendar connected', async () => {
    const fetchSpy = makeFetchSpy();
    const { service, googleOAuth } = makeService(null);

    await expect(service.bookAppointment(bookingArgs)).rejects.toMatchObject({
      errorCode: 'CRM_NOT_CONFIGURED',
      message: 'Google Calendar not connected',
    });
    expect(googleOAuth.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never uses another workspace credentials and scopes every lookup by workspaceId', async () => {
    const fetchSpy = makeFetchSpy();
    const { service, prisma, googleOAuth } = makeService({
      workspaceId: 'ws-1',
      accessToken: sealed('ws1-access'),
      refreshToken: sealed('ws1-refresh'),
      tokenExpiry: new Date(Date.now() + HOUR_MS),
    });

    await service.bookAppointment(bookingArgs);
    expect(prisma.googleCalendarConfig.findUnique).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
    });

    // A different tenant has no config of its own and must not inherit ws-1's.
    await expect(
      service.bookAppointment({ ...bookingArgs, workspaceId: 'ws-2' }),
    ).rejects.toMatchObject({ errorCode: 'CRM_NOT_CONFIGURED' });

    expect(googleOAuth.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(authHeader(fetchSpy)).toBe('Bearer ws1-access');
  });

  it('does not share an in-flight refresh between two workspaces', async () => {
    makeFetchSpy();
    const { service, prisma, googleOAuth } = makeService({
      accessToken: sealed('stale-access'),
      refreshToken: sealed('stored-refresh'),
      tokenExpiry: new Date(Date.now() - HOUR_MS),
    });
    googleOAuth.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-access',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    await Promise.all([
      service.bookAppointment({ ...bookingArgs, workspaceId: 'ws-1' }),
      service.bookAppointment({ ...bookingArgs, workspaceId: 'ws-2' }),
    ]);

    expect(googleOAuth.refreshAccessToken).toHaveBeenCalledTimes(2);
    const scopes = [writeArgs(prisma, 0).where.workspaceId, writeArgs(prisma, 1).where.workspaceId];
    expect(scopes.sort()).toEqual(['ws-1', 'ws-2']);
  });
});

describe('CalendarService credential storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encrypts tokens at rest when connecting', async () => {
    const { service, prisma, encryption } = makeService(null);

    await service.connectGoogleCalendar({
      workspaceId: 'ws-1',
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      tokenExpiry: '2026-09-01T00:00:00.000Z',
    });

    expect(encryption.encryptJson).toHaveBeenCalledWith('plain-access');
    expect(encryption.encryptJson).toHaveBeenCalledWith('plain-refresh');

    const call = prisma.googleCalendarConfig.upsert.mock.calls[0];
    if (!call) throw new Error('upsert was not called');
    const args = call[0] as {
      where: { workspaceId: string };
      create: { accessToken: string; refreshToken: string };
      update: { accessToken: string; refreshToken: string };
    };
    expect(args.where).toEqual({ workspaceId: 'ws-1' });
    for (const stored of [
      args.create.accessToken,
      args.create.refreshToken,
      args.update.accessToken,
      args.update.refreshToken,
    ]) {
      expect(stored).not.toContain('plain-access');
      expect(stored).not.toContain('plain-refresh');
      expect(JSON.parse(stored)).toMatchObject({ v: 1, alg: 'aes-256-gcm' });
    }
  });

  it('deletes the config scoped to the workspace on disconnect', async () => {
    const { service, prisma } = makeService(null);

    await service.disconnectGoogleCalendar('ws-1');

    expect(prisma.googleCalendarConfig.delete).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
    });
  });

  it('swallows delete errors so disconnect stays idempotent', async () => {
    const { service, prisma } = makeService(null);
    prisma.googleCalendarConfig.delete.mockRejectedValue(new Error('record not found'));

    await expect(service.disconnectGoogleCalendar('ws-1')).resolves.toBeUndefined();
  });
});
