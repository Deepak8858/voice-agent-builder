import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallAdmissionService } from './call-admission.service';

const INPUT = {
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  callId: 'call-1',
  provider: 'openai-realtime',
  direction: 'outbound' as const,
};

function makeService(overrides?: {
  entitlementAllowed?: boolean;
  entitlementReason?: string;
  concurrentCalls?: number;
  lease?: unknown;
  reservation?: unknown;
  reservationThrows?: boolean;
  usageThrows?: boolean;
  auditThrows?: boolean;
}) {
  const prisma = {
    callUsage: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    callConcurrencyLease: {
      findFirst: vi.fn(async () => ({ leaseToken: 'lease-1' })),
    },
  };
  if (overrides?.usageThrows) {
    prisma.callUsage.upsert.mockRejectedValue(new Error('database unavailable'));
  }

  const entitlements = {
    getEffectivePlan: vi.fn(async () => ({
      organizationId: 'org-1',
      plan: 'starter',
      status: 'active',
      catalogVersion: 1,
      paidAccess: true,
      entitlements: { concurrentCalls: overrides?.concurrentCalls ?? 2 },
    })),
    check: vi.fn(async () => ({
      allowed: overrides?.entitlementAllowed ?? true,
      reason: overrides?.entitlementReason ?? 'allowed',
      plan: 'starter',
      current: 600,
      limit: 60,
      correlationId: 'ent_1',
      catalogVersion: 1,
    })),
  };

  const concurrency = {
    acquire: vi.fn(async () =>
      overrides?.lease ?? {
        allowed: true,
        leaseToken: 'lease-1',
        expiresAt: new Date(2_000_000_000_000).toISOString(),
      },
    ),
    release: vi.fn(async () => undefined),
  };

  const creditLedger = {
    reserveInitialMinute: vi.fn(async () =>
      overrides?.reservation ?? { allowed: true, reason: 'allowed', seconds: 60 },
    ),
    releaseReservation: vi.fn(async () => ({})),
  };
  if (overrides?.reservationThrows) {
    creditLedger.reserveInitialMinute.mockRejectedValue(new Error('ledger unavailable'));
  }

  const audit = { log: vi.fn(async () => undefined) };
  if (overrides?.auditThrows) {
    audit.log.mockRejectedValue(new Error('audit sink unavailable'));
  }
  const metrics = { callsAdmissionDeniedTotal: { inc: vi.fn() } };

  const service = new CallAdmissionService(
    prisma as never,
    entitlements as never,
    concurrency as never,
    creditLedger as never,
    audit as never,
    metrics as never,
  );

  return { service, prisma, entitlements, concurrency, creditLedger, audit, metrics };
}

describe('CallAdmissionService.admitCall', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reserves credit and persists usage only after the lease is held', async () => {
    const { service, prisma, concurrency, creditLedger, audit } = makeService();

    await expect(service.admitCall(INPUT)).resolves.toEqual({
      admitted: true,
      leaseToken: 'lease-1',
      leaseExpiresAt: new Date(2_000_000_000_000).toISOString(),
      reservedSeconds: 60,
    });

    expect(concurrency.acquire).toHaveBeenCalledWith({
      callId: 'call-1',
      organizationId: 'org-1',
      organizationLimit: 2,
    });
    expect(creditLedger.reserveInitialMinute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'call:call-1:initial_minute' }),
    );
    expect(prisma.callUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { callId: 'call-1' },
        create: expect.objectContaining({
          organizationId: 'org-1',
          workspaceId: 'ws-1',
          reservedSeconds: 60,
          finalizationState: 'pending',
        }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.call_admitted' }),
    );
  });

  it('never consults Redis for a plan with no concurrency contract', async () => {
    const { service, concurrency, creditLedger, metrics } = makeService({ concurrentCalls: 0 });

    await expect(service.admitCall(INPUT)).resolves.toMatchObject({
      admitted: false,
      reason: 'organization_concurrency_reached',
    });

    expect(concurrency.acquire).not.toHaveBeenCalled();
    expect(creditLedger.reserveInitialMinute).not.toHaveBeenCalled();
    expect(metrics.callsAdmissionDeniedTotal.inc).toHaveBeenCalledWith({
      reason: 'organization_concurrency_reached',
    });
  });

  it('does not acquire a lease when the plan denies the call', async () => {
    const { service, concurrency, creditLedger, audit } = makeService({
      entitlementAllowed: false,
      entitlementReason: 'credit_insufficient',
    });

    await expect(service.admitCall(INPUT)).resolves.toMatchObject({
      admitted: false,
      reason: 'credit_insufficient',
    });

    expect(concurrency.acquire).not.toHaveBeenCalled();
    expect(creditLedger.reserveInitialMinute).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.call_admission_denied' }),
    );
  });

  it('returns the concurrency slot when the credit reservation is refused', async () => {
    const { service, concurrency, prisma } = makeService({
      reservation: { allowed: false, reason: 'credit_insufficient', seconds: 0 },
    });

    await expect(service.admitCall(INPUT)).resolves.toMatchObject({
      admitted: false,
      reason: 'credit_insufficient',
    });

    expect(concurrency.release).toHaveBeenCalledWith({
      callId: 'call-1',
      organizationId: 'org-1',
      leaseToken: 'lease-1',
    });
    expect(prisma.callUsage.upsert).not.toHaveBeenCalled();
  });

  it('returns the concurrency slot and reports a retryable failure when the ledger throws', async () => {
    const { service, concurrency } = makeService({ reservationThrows: true });

    await expect(service.admitCall(INPUT)).resolves.toMatchObject({
      admitted: false,
      reason: 'billing_temporarily_unavailable',
    });

    expect(concurrency.release).toHaveBeenCalled();
  });

  it('releases both the reservation and the lease when usage persistence fails', async () => {
    const { service, concurrency, creditLedger } = makeService({ usageThrows: true });

    await expect(service.admitCall(INPUT)).resolves.toMatchObject({
      admitted: false,
      reason: 'billing_temporarily_unavailable',
    });

    expect(creditLedger.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'call:call-1:reservation_release' }),
    );
    expect(concurrency.release).toHaveBeenCalled();
  });

  it('hands back every acquired resource when the admission audit cannot be written', async () => {
    const { service, prisma, concurrency, creditLedger, metrics } = makeService({
      auditThrows: true,
    });

    // No exception reaches the caller: an unwritable audit record is a denial,
    // not a crash, and the call must not have consumed anything.
    await expect(service.admitCall(INPUT)).resolves.toMatchObject({
      admitted: false,
      reason: 'billing_temporarily_unavailable',
    });

    expect(creditLedger.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'call:call-1:reservation_release' }),
    );
    expect(concurrency.release).toHaveBeenCalledWith({
      callId: 'call-1',
      organizationId: 'org-1',
      leaseToken: 'lease-1',
    });
    expect(prisma.callUsage.updateMany).toHaveBeenCalledWith({
      where: { callId: 'call-1', finalizationState: { not: 'finalized' } },
      data: expect.objectContaining({
        disposition: 'admission_audit_failed',
        finalizationState: 'finalized',
      }),
    });
    expect(metrics.callsAdmissionDeniedTotal.inc).toHaveBeenCalledWith({
      reason: 'billing_temporarily_unavailable',
    });
  });

  it('still returns a clean denial when the denial audit itself fails', async () => {
    const { service, concurrency, creditLedger } = makeService({
      auditThrows: true,
      entitlementAllowed: false,
      entitlementReason: 'credit_insufficient',
    });

    await expect(service.admitCall(INPUT)).resolves.toMatchObject({
      admitted: false,
      reason: 'credit_insufficient',
    });

    // Nothing was acquired on this path, so nothing needs releasing.
    expect(concurrency.release).not.toHaveBeenCalled();
    expect(creditLedger.releaseReservation).not.toHaveBeenCalled();
  });

  it('maps an operator fault to a retryable 503 and a customer fault to a 403', async () => {
    const { service } = makeService();

    const operatorFault = service.toError({
      admitted: false,
      reason: 'billing_temporarily_unavailable',
      message: 'unavailable',
    });
    expect(operatorFault.errorCode).toBe('BILLING_UNAVAILABLE');
    expect(operatorFault.getStatus()).toBe(503);
    expect(operatorFault.details).toEqual({ reason: 'billing_temporarily_unavailable' });

    const customerFault = service.toError({
      admitted: false,
      reason: 'credit_insufficient',
      message: 'no credit',
    });
    expect(customerFault.errorCode).toBe('PLAN_LIMIT_EXCEEDED');
    expect(customerFault.getStatus()).toBe(403);
    // The campaign worker classifies denials by this reason.
    expect(customerFault.details).toEqual({ reason: 'credit_insufficient' });
  });
});

describe('CallAdmissionService.reassertLease', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-takes the slot for an already-admitted call and audits the reassertion', async () => {
    const { service, concurrency, audit } = makeService();

    await expect(service.reassertLease('org-1', 'call-1')).resolves.toBe(true);

    expect(concurrency.acquire).toHaveBeenCalledWith({
      callId: 'call-1',
      organizationId: 'org-1',
      organizationLimit: 2,
    });
    expect(audit.log).toHaveBeenCalledWith({
      organizationId: 'org-1',
      action: 'billing.call_lease_reasserted',
      resourceType: 'call',
      resourceId: 'call-1',
      metadata: {
        organizationLimit: 2,
        leaseExpiresAt: new Date(2_000_000_000_000).toISOString(),
      },
    });
  });

  it('refuses and audits when the organization is back at its concurrency cap', async () => {
    const { service, audit } = makeService({
      lease: { allowed: false, reason: 'organization_concurrency_reached' },
    });

    await expect(service.reassertLease('org-1', 'call-1')).resolves.toBe(false);

    expect(audit.log).toHaveBeenCalledWith({
      organizationId: 'org-1',
      action: 'billing.call_lease_reassertion_denied',
      resourceType: 'call',
      resourceId: 'call-1',
      metadata: { reason: 'organization_concurrency_reached', organizationLimit: 2 },
    });
  });

  it('refuses without consulting Redis when the plan has no concurrency contract', async () => {
    const { service, concurrency, audit } = makeService({ concurrentCalls: 0 });

    await expect(service.reassertLease('org-1', 'call-1')).resolves.toBe(false);

    expect(concurrency.acquire).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.call_lease_reassertion_denied',
        metadata: { reason: 'organization_concurrency_reached', organizationLimit: 0 },
      }),
    );
  });

  it('fails closed when the plan lookup throws', async () => {
    const { service, entitlements, concurrency } = makeService();
    entitlements.getEffectivePlan.mockRejectedValue(new Error('billing db down'));

    await expect(service.reassertLease('org-1', 'call-1')).resolves.toBe(false);

    expect(concurrency.acquire).not.toHaveBeenCalled();
  });

  it('refuses the reassertion when the success audit cannot be written', async () => {
    const { service } = makeService({ auditThrows: true });

    await expect(service.reassertLease('org-1', 'call-1')).resolves.toBe(false);
  });

  it('still returns a clean refusal when the denial audit itself fails', async () => {
    const { service } = makeService({
      auditThrows: true,
      lease: { allowed: false, reason: 'organization_concurrency_reached' },
    });

    await expect(service.reassertLease('org-1', 'call-1')).resolves.toBe(false);
  });
});

describe('CallAdmissionService.compensate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('releases credit, frees the slot, and finalizes usage', async () => {
    const { service, prisma, concurrency, creditLedger } = makeService();

    await service.compensate('org-1', 'call-1', 'provider_dispatch_failed');

    expect(creditLedger.releaseReservation).toHaveBeenCalled();
    expect(concurrency.release).toHaveBeenCalled();
    expect(prisma.callUsage.updateMany).toHaveBeenCalledWith({
      where: { callId: 'call-1', finalizationState: { not: 'finalized' } },
      data: expect.objectContaining({
        disposition: 'provider_dispatch_failed',
        finalizationState: 'finalized',
      }),
    });
  });

  it('still frees the slot when the reservation was already committed', async () => {
    const { service, concurrency, creditLedger } = makeService();
    creditLedger.releaseReservation.mockRejectedValue(
      new Error('Cannot release committed reservation'),
    );

    await expect(
      service.compensate('org-1', 'call-1', 'provider_dispatch_failed'),
    ).resolves.toBeUndefined();

    expect(concurrency.release).toHaveBeenCalled();
  });
});
