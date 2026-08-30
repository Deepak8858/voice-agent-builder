import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_TWIML_WEBHOOK_URL: 'https://api.example.com',
  TWILIO_STATUS_WEBHOOK_URL: 'https://api.example.com',
}));

vi.mock('../config/env', () => ({ env: envState }));

import { EntitlementService } from '../billing/entitlement.service';
import { PhoneNumbersService } from './phone-numbers.service';
import { AddByoPhoneNumberDtoSchema, ProvisionPhoneNumberDtoSchema } from './phone-numbers.schemas';

const PROVISIONED_NUMBER = {
  id: 'number-1',
  workspaceId: 'workspace-1',
  phoneNumber: '+14155551234',
  type: 'local',
  twilioSid: 'PN00000000000000000000000000000001',
  agentId: null,
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function makeService(overrides?: {
  gateAllows?: boolean;
  create?: () => Promise<unknown>;
  existingNumber?: unknown;
  deletedCount?: number;
  /** Numbers the organization already holds, across all of its workspaces. */
  numberCount?: number;
  plan?: string;
}) {
  const prisma = {
    workspace: {
      findUniqueOrThrow: vi.fn(async () => ({ organizationId: 'org-1' })),
    },
    agent: {
      findFirst: vi.fn(async () => ({ id: 'agent-1' })),
    },
    twilioPhoneNumber: {
      create: vi.fn(
        overrides?.create ?? (async () => ({ id: 'number-1', phoneNumber: '+14155551234' })),
      ),
      findFirst: vi.fn(async () => overrides?.existingNumber ?? null),
      deleteMany: vi.fn(async () => ({ count: overrides?.deletedCount ?? 1 })),
      count: vi.fn(async () => overrides?.numberCount ?? 0),
    },
    // Read by the real EntitlementService below, so the cap these tests assert is
    // the catalog's own number rather than one restated here.
    subscription: {
      findUnique: vi.fn(async () => ({ plan: overrides?.plan ?? 'starter', status: 'active' })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
  const audit = { log: vi.fn(async () => undefined) };
  const billing = { checkFeatureGate: vi.fn(async () => overrides?.gateAllows ?? true) };
  const entitlements = new EntitlementService(prisma as never);
  const service = new PhoneNumbersService(
    prisma as never,
    audit as never,
    billing as never,
    entitlements,
  );
  return { service, prisma, audit, billing, entitlements };
}

describe('PhoneNumbersService plan gates', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('refuses addByo on a plan without byo_telephony and writes no row', async () => {
    const { service, prisma, billing } = makeService({ gateAllows: false });

    await expect(
      service.addByo('workspace-1', '+14155551234'),
    ).rejects.toMatchObject({ errorCode: 'PLAN_LIMIT_EXCEEDED' });

    expect(billing.checkFeatureGate).toHaveBeenCalledWith('org-1', 'byo_telephony');
    expect(prisma.twilioPhoneNumber.create).not.toHaveBeenCalled();
  });

  it('reports a duplicate BYO number as a conflict rather than a 500', async () => {
    const { service } = makeService({
      create: async () => {
        throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
      },
    });

    await expect(service.addByo('workspace-1', '+14155551234')).rejects.toMatchObject({
      errorCode: 'PHONE_NUMBER_ALREADY_CONNECTED',
    });
  });

  it('refuses provision on an unpaid plan before any Twilio call is made', async () => {
    const { service, billing } = makeService({ gateAllows: false });

    await expect(service.provision('workspace-1', '415')).rejects.toMatchObject({
      errorCode: 'PLAN_LIMIT_EXCEEDED',
      // The refusal names the capability that was actually refused; the upgrade
      // modal renders this string.
      details: { limitType: 'managed_telephony' },
    });

    expect(billing.checkFeatureGate).toHaveBeenCalledWith('org-1', 'managed_telephony');
    // The whole point of gating here: no search, no purchase, no money spent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The capability gate alone bounded nothing: a paying Starter owner could loop
   * `POST /provision` and rent unbounded numbers on VoiceForge's own Twilio
   * account at ~$1.15/month each. The refusal must land before the search, so no
   * money leaves.
   */
  it('refuses provision once the organization holds every number its plan allows', async () => {
    const { service } = makeService({ plan: 'starter', numberCount: 2 });
    // Deliberately primed to succeed: if the cap were evaluated after the
    // carrier calls, the search and purchase would both go through and only the
    // `not.toHaveBeenCalled()` below would notice. Without these stubs a
    // mis-ordered gate fails on an unrelated TypeError instead.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ available_phone_numbers: [{ phone_number: '+14155551234' }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ sid: 'PN00000000000000000000000000000009', phone_number: '+14155551234' }),
      );

    await expect(service.provision('workspace-1', '415')).rejects.toMatchObject({
      errorCode: 'PLAN_LIMIT_EXCEEDED',
      details: expect.objectContaining({
        reason: 'phone_number_limit_reached',
        current: 2,
        limit: 2,
        plan: 'starter',
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts the numbers the organization holds, not just the calling workspace', async () => {
    // A per-workspace count caps nothing on a plan that can create more
    // workspaces, so the predicate must reach the organization and must not
    // mention the calling workspace at all.
    const { service, prisma } = makeService({ plan: 'growth', numberCount: 10 });

    await expect(service.provision('workspace-1', '415')).rejects.toMatchObject({
      errorCode: 'PLAN_LIMIT_EXCEEDED',
      details: expect.objectContaining({ reason: 'phone_number_limit_reached', limit: 10 }),
    });

    expect(prisma.twilioPhoneNumber.count).toHaveBeenCalledWith({
      where: { workspace: { organizationId: 'org-1' } },
    });
  });

  it('caps addByo against the same quota, so BYO cannot outrun the plan', async () => {
    // BYO spends no platform money, but registration does not prove ownership
    // and `phoneNumber` is uniquely indexed, so an uncapped addByo lets one
    // workspace permanently squat unbounded numbers it does not own.
    const { service, prisma } = makeService({ plan: 'starter', numberCount: 2 });

    await expect(service.addByo('workspace-1', '+14155551234')).rejects.toMatchObject({
      errorCode: 'PLAN_LIMIT_EXCEEDED',
      details: expect.objectContaining({ reason: 'phone_number_limit_reached' }),
    });

    expect(prisma.twilioPhoneNumber.create).not.toHaveBeenCalled();
  });

  it('hands a purchased number back to Twilio when the local row cannot be written', async () => {
    const { service } = makeService({
      create: async () => {
        throw new Error('insert failed');
      },
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ available_phone_numbers: [{ phone_number: '+14155551234' }] }))
      .mockResolvedValueOnce(jsonResponse({ sid: 'PN00000000000000000000000000000009', phone_number: '+14155551234' }))
      .mockResolvedValueOnce({ ok: true, status: 204 });

    await expect(service.provision('workspace-1', '415')).rejects.toThrow(
      'insert failed',
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [releaseUrl, releaseInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(releaseUrl).toContain('/IncomingPhoneNumbers/PN00000000000000000000000000000009.json');
    expect(releaseInit.method).toBe('DELETE');
  });
});

describe('PhoneNumbersService acquisition audit trail', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  // Provisioning starts a recurring carrier rental and opens a new inbound route
  // into the workspace. `assign` and `release` were audited; the two doors that
  // create the number were not, so nothing recorded who spent the money.
  it('logs the provision once the local row exists', async () => {
    const { service, audit } = makeService();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ available_phone_numbers: [{ phone_number: '+14155551234' }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ sid: 'PN00000000000000000000000000000009', phone_number: '+14155551234' }),
      );

    await service.provision('workspace-1', '415', 'agent-1', 'user-1');

    expect(audit.log).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      actorUserId: 'user-1',
      action: 'phone_number.provision',
      resourceType: 'twilio_phone_number',
      resourceId: 'number-1',
      metadata: {
        phone_number: '+14155551234',
        twilio_sid: 'PN00000000000000000000000000000009',
        agent_id: 'agent-1',
      },
    });
  });

  it('writes no provision entry when the local row could not be written', async () => {
    const { service, audit } = makeService({
      create: async () => {
        throw new Error('insert failed');
      },
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ available_phone_numbers: [{ phone_number: '+14155551234' }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ sid: 'PN00000000000000000000000000000009', phone_number: '+14155551234' }),
      )
      .mockResolvedValueOnce({ ok: true, status: 204 });

    await expect(service.provision('workspace-1', '415', undefined, 'user-1')).rejects.toThrow(
      'insert failed',
    );

    expect(audit.log).not.toHaveBeenCalled();
  });

  it('logs a BYO registration', async () => {
    const { service, audit } = makeService();

    await service.addByo(
      'workspace-1',
      '+14155551234',
      'PN00000000000000000000000000000001',
      'user-1',
    );

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        actorUserId: 'user-1',
        action: 'phone_number.byo_add',
        resourceType: 'twilio_phone_number',
        resourceId: 'number-1',
        metadata: expect.objectContaining({
          phone_number: '+14155551234',
          twilio_sid: 'PN00000000000000000000000000000001',
        }),
      }),
    );
  });

  // A rejected duplicate claim wrote no row, so it must leave no audit record
  // either - otherwise the log implies a number this workspace does not hold.
  it('writes no entry when a BYO claim is rejected as a duplicate', async () => {
    const { service, audit } = makeService({
      create: async () => {
        throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
      },
    });

    await expect(
      service.addByo('workspace-1', '+14155551234', undefined, 'user-1'),
    ).rejects.toMatchObject({ errorCode: 'PHONE_NUMBER_ALREADY_CONNECTED' });

    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('PhoneNumbersService.release', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('keeps the local row and the audit trail when Twilio refuses the release', async () => {
    const { service, prisma, audit } = makeService({ existingNumber: PROVISIONED_NUMBER });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(service.release('workspace-1', 'number-1', 'user-1')).rejects.toMatchObject({
      errorCode: 'VOICE_PROVIDER_ERROR',
    });

    // The row is the only remaining handle on a number that is still billing.
    expect(prisma.twilioPhoneNumber.deleteMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('writes no audit entry when a concurrent release already removed the row', async () => {
    const { service, audit } = makeService({
      existingNumber: { ...PROVISIONED_NUMBER, type: 'byo', twilioSid: null },
      deletedCount: 0,
    });

    await service.release('workspace-1', 'number-1', 'user-1');

    expect(audit.log).not.toHaveBeenCalled();
  });

  it('releases with DELETE, then drops the row', async () => {
    const { service, prisma, audit } = makeService({ existingNumber: PROVISIONED_NUMBER });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 });

    await service.release('workspace-1', 'number-1', 'user-1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(prisma.twilioPhoneNumber.deleteMany).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
});

describe('phone number request schemas', () => {
  it('rejects a phone number that is not E.164', () => {
    expect(AddByoPhoneNumberDtoSchema.safeParse({ phone_number: '4155551234' }).success).toBe(false);
    expect(AddByoPhoneNumberDtoSchema.safeParse({ phone_number: '+14155551234' }).success).toBe(
      true,
    );
  });

  it('rejects a twilio_sid that is not a PN SID', () => {
    expect(
      AddByoPhoneNumberDtoSchema.safeParse({
        phone_number: '+14155551234',
        twilio_sid: '../../Accounts/ACother/IncomingPhoneNumbers/PN1',
      }).success,
    ).toBe(false);
  });

  it('rejects an area code carrying extra Twilio query parameters', () => {
    expect(ProvisionPhoneNumberDtoSchema.safeParse({ area_code: '415&Limit=50' }).success).toBe(
      false,
    );
    expect(ProvisionPhoneNumberDtoSchema.safeParse({ area_code: '415' }).success).toBe(true);
  });
});
