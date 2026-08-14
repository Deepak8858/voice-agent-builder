import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ApiErrorCode, EntitlementReason } from '@voiceforge/shared';
import { PAID_CALL_MINIMUM_SECONDS } from '@voiceforge/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { MetricsService } from '../common/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { CallConcurrencyService } from './call-concurrency.service';
import { CreditLedgerService, type MinuteReservation } from './credit-ledger.service';
import { EntitlementService } from './entitlement.service';

export interface AdmitCallInput {
  organizationId: string;
  workspaceId: string;
  callId: string;
  provider: string;
  direction: 'outbound' | 'inbound';
  providerCallId?: string | null;
}

export interface AdmittedCall {
  admitted: true;
  leaseToken: string;
  leaseExpiresAt: string;
  reservedSeconds: number;
}

export interface DeniedCall {
  admitted: false;
  reason: EntitlementReason;
  message: string;
}

export type CallAdmission = AdmittedCall | DeniedCall;

/**
 * Customer-facing failures that are the customer's to fix (no credit, plan does
 * not include the capability) are separated from failures that are ours
 * (billing under review, Redis or PostgreSQL unavailable). The first is a 403
 * the caller can act on; the second is a 503 that should be retried.
 */
const OPERATOR_FAULT_REASONS: ReadonlySet<EntitlementReason> = new Set([
  'billing_temporarily_unavailable',
]);

/**
 * The single admission gate for a paid call.
 *
 * A call may only reach a voice provider after four things hold together:
 * the plan permits it, the organization is under its concurrency limit, a
 * minute of credit is reserved against the ledger, and the usage record that
 * metering and reconciliation read from exists. Any failure after the first
 * successful step compensates the earlier ones, so a refused call never leaves
 * credit reserved or a concurrency slot consumed.
 *
 * The call row must already exist: the concurrency lease and the usage record
 * are foreign-keyed to it, and the ledger refuses to reserve against a call it
 * cannot scope to the organization.
 */
@Injectable()
export class CallAdmissionService {
  private readonly logger = new Logger(CallAdmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly concurrency: CallConcurrencyService,
    private readonly creditLedger: CreditLedgerService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  async admitCall(input: AdmitCallInput): Promise<CallAdmission> {
    const effective = await this.entitlements.getEffectivePlan(input.organizationId);

    const entitlement = await this.entitlements.check(input.organizationId, {
      kind: 'paid_call',
      minimumSeconds: PAID_CALL_MINIMUM_SECONDS,
    });
    if (!entitlement.allowed) {
      return this.deny(input, entitlement.reason, {
        plan: entitlement.plan,
        current: entitlement.current,
        limit: entitlement.limit,
        correlationId: entitlement.correlationId,
        catalogVersion: entitlement.catalogVersion,
      });
    }

    // A plan with no concurrency contract can never hold a lease. Redis is not
    // consulted, because the acquire contract requires a limit of at least one.
    const organizationLimit = effective.entitlements.concurrentCalls;
    if (organizationLimit < 1) {
      return this.deny(input, 'organization_concurrency_reached', {
        plan: effective.plan,
        limit: organizationLimit,
      });
    }

    const lease = await this.concurrency.acquire({
      callId: input.callId,
      organizationId: input.organizationId,
      organizationLimit,
    });
    if (lease.allowed === false) {
      return this.deny(input, lease.reason, { plan: effective.plan, limit: organizationLimit });
    }

    let reservation: MinuteReservation;
    try {
      reservation = await this.creditLedger.reserveInitialMinute({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        callId: input.callId,
        idempotencyKey: this.reservationKey(input.callId),
      });
    } catch (err) {
      this.logger.error(
        `Credit reservation failed for call ${input.callId}: ${(err as Error).message}`,
      );
      await this.releaseLease(input.organizationId, input.callId);
      return this.deny(input, 'billing_temporarily_unavailable', { plan: effective.plan });
    }

    if (!reservation.allowed) {
      await this.releaseLease(input.organizationId, input.callId);
      return this.deny(input, reservation.reason, { plan: effective.plan });
    }

    try {
      await this.recordUsage(input, reservation.seconds);
    } catch (err) {
      this.logger.error(
        `Call usage persistence failed for call ${input.callId}: ${(err as Error).message}`,
      );
      await this.compensate(input.organizationId, input.callId, 'usage_persistence_failed');
      return this.deny(input, 'billing_temporarily_unavailable', { plan: effective.plan });
    }

    await this.audit.log({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      action: 'billing.call_admitted',
      resourceType: 'call',
      resourceId: input.callId,
      metadata: {
        plan: effective.plan,
        provider: input.provider,
        direction: input.direction,
        reservedSeconds: reservation.seconds,
        organizationConcurrencyLimit: organizationLimit,
        catalogVersion: effective.catalogVersion,
      },
    });

    return {
      admitted: true,
      leaseToken: lease.leaseToken,
      leaseExpiresAt: lease.expiresAt,
      reservedSeconds: reservation.seconds,
    };
  }

  /**
   * Undo a completed admission. Used when the provider refuses the call after
   * we have already reserved credit, and by the runtime when a call fails
   * before it ever connects. Safe to call more than once: the ledger release is
   * idempotent and a released lease stays released.
   */
  async compensate(organizationId: string, callId: string, disposition: string): Promise<void> {
    try {
      await this.creditLedger.releaseReservation({
        organizationId,
        callId,
        idempotencyKey: this.releaseKey(callId),
      });
    } catch (err) {
      // A committed reservation cannot be released; that is the connected-call
      // path and is not an error worth failing the caller over.
      this.logger.warn(
        `Reservation release skipped for call ${callId}: ${(err as Error).message}`,
      );
    }
    await this.releaseLease(organizationId, callId);
    await this.finalizeUsage(callId, disposition);
  }

  /** Release only the concurrency slot, leaving settled credit untouched. */
  async releaseLease(organizationId: string, callId: string): Promise<void> {
    try {
      const lease = await this.prisma.callConcurrencyLease.findFirst({
        where: { callId, organizationId, state: 'active' },
        select: { leaseToken: true },
      });
      if (!lease) return;
      await this.concurrency.release({ callId, organizationId, leaseToken: lease.leaseToken });
    } catch (err) {
      this.logger.error(
        `Concurrency lease release failed for call ${callId}: ${(err as Error).message}`,
      );
    }
  }

  async finalizeUsage(callId: string, disposition: string): Promise<void> {
    try {
      await this.prisma.callUsage.updateMany({
        where: { callId, finalizationState: { not: 'finalized' } },
        data: {
          disposition,
          endedAt: new Date(),
          finalizationState: 'finalized',
        },
      });
    } catch (err) {
      this.logger.error(
        `Call usage finalization failed for call ${callId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Turns a denial into the error the HTTP layer should surface. Kept here so
   * every dispatch path reports the same code and message for the same reason.
   */
  toError(denial: DeniedCall): AppError {
    if (OPERATOR_FAULT_REASONS.has(denial.reason)) {
      return new AppError(
        'BILLING_UNAVAILABLE' as ApiErrorCode,
        denial.message,
        HttpStatus.SERVICE_UNAVAILABLE,
        { reason: denial.reason },
      );
    }
    return new AppError(
      'PLAN_LIMIT_EXCEEDED' as ApiErrorCode,
      denial.message,
      HttpStatus.FORBIDDEN,
      { reason: denial.reason },
    );
  }

  private async recordUsage(input: AdmitCallInput, reservedSeconds: number): Promise<void> {
    await this.prisma.callUsage.upsert({
      where: { callId: input.callId },
      create: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        callId: input.callId,
        provider: input.provider,
        providerCallId: input.providerCallId ?? null,
        direction: input.direction,
        dispatchedAt: new Date(),
        reservedSeconds,
        finalizationState: 'pending',
      },
      update: {
        provider: input.provider,
        providerCallId: input.providerCallId ?? null,
        dispatchedAt: new Date(),
        reservedSeconds,
      },
    });
  }

  private async deny(
    input: AdmitCallInput,
    reason: EntitlementReason,
    context: Record<string, unknown>,
  ): Promise<DeniedCall> {
    this.metrics.callsAdmissionDeniedTotal.inc({ reason });
    await this.audit.log({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      action: 'billing.call_admission_denied',
      resourceType: 'call',
      resourceId: input.callId,
      metadata: { reason, provider: input.provider, direction: input.direction, ...context },
    });
    return { admitted: false, reason, message: this.denialMessage(reason) };
  }

  private denialMessage(reason: EntitlementReason): string {
    switch (reason) {
      case 'credit_insufficient':
        return 'Your organization does not have enough call minutes. Buy a minute pack to continue.';
      case 'organization_concurrency_reached':
        return 'Your plan has no concurrent call capacity left. Wait for a call to finish or upgrade your plan.';
      case 'platform_concurrency_reached':
        return 'The platform is at capacity. Please retry in a moment.';
      case 'billing_temporarily_unavailable':
        return 'Billing is temporarily unavailable for your organization. No call was placed and no credit was spent.';
      case 'subscription_inactive':
        return 'Your subscription is not active. Update your payment method to continue.';
      default:
        return 'Outbound calls are not available on your plan. Upgrade to continue.';
    }
  }

  private reservationKey(callId: string): string {
    return `call:${callId}:initial_minute`;
  }

  private releaseKey(callId: string): string {
    return `call:${callId}:reservation_release`;
  }
}
