import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_TWIML_WEBHOOK_URL: 'https://api.example.com',
  TWILIO_STATUS_WEBHOOK_URL: 'https://api.example.com',
}));

vi.mock('../config/env', () => ({ env: envState }));

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
    },
  };
  const audit = { log: vi.fn(async () => undefined) };
  const billing = { checkFeatureGate: vi.fn(async () => overrides?.gateAllows ?? true) };
  const service = new PhoneNumbersService(prisma as never, audit as never, billing as never);
  return { service, prisma, audit, billing };
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
