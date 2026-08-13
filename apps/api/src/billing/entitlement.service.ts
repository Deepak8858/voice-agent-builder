import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ApiErrorCode,
  EffectivePlan,
  EffectiveSubscriptionStatus,
  EntitlementDecision,
  EntitlementReason,
  EntitlementRequest,
  PlanEntitlements,
  PlanType,
} from '@voiceforge/shared';
import { BILLING_CATALOG_VERSION, getPlanEntitlements } from '@voiceforge/shared';
import { AppError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Stripe states that fund paid usage. Every other state — including `past_due`,
 * `unpaid`, `incomplete`, `incomplete_expired`, `paused`, and `canceled` — must
 * stop new paid work, because the organization has no confirmed revenue behind
 * it.
 */
const PAID_ACCESS_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

const PLAN_TYPES: ReadonlySet<string> = new Set<PlanType>([
  'free',
  'starter',
  'growth',
  'enterprise',
]);

const SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
]);

/**
 * The single source of truth for "may this organization do that?".
 *
 * Callers pass a typed request and receive a decision that always carries the
 * current value, the plan limit, the catalog version that produced the limit,
 * and a correlation ID linking the decision to its audit record. Quota counts
 * are organization-wide: a workspace is never a quota boundary.
 */
@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePlan(organizationId: string): Promise<EffectivePlan> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { organizationId },
      select: {
        plan: true,
        status: true,
        trialEnd: true,
        concurrentCallLimitOverride: true,
      },
    });

    const status = this.resolveStatus(subscription?.status);
    const storedPlan = this.resolvePlan(subscription?.plan);
    const trialExpired =
      status === 'trialing' &&
      subscription?.trialEnd instanceof Date &&
      subscription.trialEnd.getTime() <= Date.now();

    // A paid plan name without a funding status is not paid access. An expired
    // trial falls all the way back to Free so no downstream caller can read a
    // paid entitlement from a stale row.
    const paidAccess = PAID_ACCESS_STATUSES.has(status) && !trialExpired && storedPlan !== 'free';
    const plan: PlanType = paidAccess ? storedPlan : 'free';

    return {
      organizationId,
      plan,
      status,
      catalogVersion: BILLING_CATALOG_VERSION,
      entitlements: this.resolveEntitlements(plan, subscription?.concurrentCallLimitOverride),
      paidAccess,
    };
  }

  async check(
    organizationId: string,
    request: EntitlementRequest,
  ): Promise<EntitlementDecision> {
    const effective = await this.getEffectivePlan(organizationId);
    const correlationId = `ent_${randomUUID()}`;

    switch (request.kind) {
      case 'paid_call':
        return this.checkPaidCall(effective, request.minimumSeconds, correlationId);
      case 'browser_test':
        return this.checkBrowserTest(effective, correlationId);
      case 'agent_create':
        return this.checkQuota(
          effective,
          correlationId,
          request.current,
          effective.entitlements.agents,
          'agent_limit_reached',
        );
      case 'workspace_create':
        return this.checkQuota(
          effective,
          correlationId,
          request.current,
          effective.entitlements.workspaces,
          'workspace_limit_reached',
        );
      case 'integration_connect':
        return this.checkQuota(
          effective,
          correlationId,
          request.current,
          effective.entitlements.nangoConnections,
          'integration_limit_reached',
        );
      case 'white_label':
        return this.checkFeature(effective, correlationId, effective.entitlements.whiteLabel);
      case 'campaign_launch':
        return this.checkFeature(effective, correlationId, effective.entitlements.campaigns);
    }
  }

  /**
   * Same decision as {@link check}, but a denial throws and is audited. Use this
   * immediately before the transaction that would create the record.
   */
  async assertAllowed(
    organizationId: string,
    request: EntitlementRequest,
  ): Promise<EntitlementDecision> {
    const decision = await this.check(organizationId, request);
    if (decision.allowed) return decision;

    await this.auditDenial(decision, request);
    throw new PlanQuotaExceededError(this.denialMessage(decision), {
      reason: decision.reason,
      plan: decision.plan,
      current: decision.current,
      limit: decision.limit,
      catalogVersion: decision.catalogVersion,
      correlationId: decision.correlationId,
      upgradePath: decision.plan === 'enterprise' ? 'contact_sales' : 'self_service_upgrade',
    });
  }

  /**
   * The free browser test is a lifetime allowance, not a per-request flag. It
   * is spent against a persisted redemption, so a customer cannot repeat it by
   * calling the endpoint again. A paid organization has already bought call
   * minutes and does not consume the trial.
   */
  private async checkBrowserTest(
    effective: EffectivePlan,
    correlationId: string,
  ): Promise<EntitlementDecision> {
    const limit = effective.entitlements.lifetimeBrowserTestSeconds;
    if (effective.paidAccess) {
      return this.decision(effective, correlationId, {
        allowed: true,
        reason: 'allowed',
        current: 0,
        limit,
      });
    }
    if (limit <= 0) {
      return this.decision(effective, correlationId, {
        allowed: false,
        reason: 'trial_already_used',
        current: 0,
        limit,
      });
    }

    const redemption = await this.prisma.trialRedemption.findUnique({
      where: { organizationId: effective.organizationId },
      select: { maxDurationSeconds: true },
    });
    const consumed = redemption ? redemption.maxDurationSeconds : 0;
    const allowed = consumed < limit;
    return this.decision(effective, correlationId, {
      allowed,
      reason: allowed ? 'allowed' : 'trial_already_used',
      current: consumed,
      limit,
    });
  }

  private async checkPaidCall(
    effective: EffectivePlan,
    minimumSeconds: number,
    correlationId: string,
  ): Promise<EntitlementDecision> {
    if (!effective.entitlements.outboundPstn || !effective.paidAccess) {
      return this.decision(effective, correlationId, {
        allowed: false,
        reason: this.unavailableReason(effective),
        current: 0,
        limit: minimumSeconds,
      });
    }

    const balance = await this.prisma.organizationCreditBalance.findUnique({
      where: { organizationId: effective.organizationId },
      select: { availableSeconds: true, status: true },
    });

    if (balance && balance.status !== 'active') {
      return this.decision(effective, correlationId, {
        allowed: false,
        reason: 'billing_temporarily_unavailable',
        current: balance.availableSeconds,
        limit: minimumSeconds,
      });
    }

    const availableSeconds = balance?.availableSeconds ?? 0;
    const funded = availableSeconds >= minimumSeconds;
    return this.decision(effective, correlationId, {
      allowed: funded,
      reason: funded ? 'allowed' : 'credit_insufficient',
      current: availableSeconds,
      limit: minimumSeconds,
    });
  }

  private checkQuota(
    effective: EffectivePlan,
    correlationId: string,
    current: number,
    limit: number,
    reason: EntitlementReason,
  ): EntitlementDecision {
    const allowed = current < limit;
    return this.decision(effective, correlationId, {
      allowed,
      reason: allowed ? 'allowed' : reason,
      current,
      limit,
    });
  }

  private checkFeature(
    effective: EffectivePlan,
    correlationId: string,
    enabled: boolean,
  ): EntitlementDecision {
    return this.decision(effective, correlationId, {
      allowed: enabled,
      reason: enabled ? 'allowed' : this.unavailableReason(effective),
      current: 0,
      limit: enabled ? 1 : 0,
    });
  }

  /**
   * Separates "this plan never included the capability" from "a paid
   * subscription exists but is not currently funding usage". The customer-facing
   * remedy differs: one is an upgrade, the other is a payment fix.
   */
  private unavailableReason(effective: EffectivePlan): EntitlementReason {
    return effective.status === 'active' || effective.status === 'none'
      ? 'subscription_required'
      : 'subscription_inactive';
  }

  private decision(
    effective: EffectivePlan,
    correlationId: string,
    result: {
      allowed: boolean;
      reason: EntitlementReason;
      current: number;
      limit: number;
    },
  ): EntitlementDecision {
    return {
      organizationId: effective.organizationId,
      plan: effective.plan,
      allowed: result.allowed,
      reason: result.reason,
      current: Math.max(0, Math.trunc(result.current)),
      limit: Math.max(0, Math.trunc(result.limit)),
      catalogVersion: effective.catalogVersion,
      correlationId,
    };
  }

  /**
   * Only Enterprise may contract a different concurrency, and never above the
   * contractual ceiling. Stale overrides on other plans are ignored rather than
   * trusted.
   */
  private resolveEntitlements(
    plan: PlanType,
    concurrentCallLimitOverride: number | null | undefined,
  ): PlanEntitlements {
    const entitlements = getPlanEntitlements(plan);
    if (plan !== 'enterprise' || typeof concurrentCallLimitOverride !== 'number') {
      return entitlements;
    }
    const clamped = Math.min(
      Math.max(1, Math.trunc(concurrentCallLimitOverride)),
      entitlements.maximumContractConcurrentCalls,
    );
    return { ...entitlements, concurrentCalls: clamped };
  }

  private resolvePlan(plan: string | undefined): PlanType {
    return plan && PLAN_TYPES.has(plan) ? (plan as PlanType) : 'free';
  }

  private resolveStatus(status: string | undefined): EffectiveSubscriptionStatus {
    if (!status) return 'none';
    return SUBSCRIPTION_STATUSES.has(status)
      ? (status as EffectiveSubscriptionStatus)
      : 'none';
  }

  private denialMessage(decision: EntitlementDecision): string {
    switch (decision.reason) {
      case 'subscription_required':
        return 'Your current plan does not include this capability. Upgrade to continue.';
      case 'subscription_inactive':
        return 'Your subscription is not active. Update your payment method to continue.';
      case 'credit_insufficient':
        return 'Your organization does not have enough call minutes. Buy a minute pack to continue.';
      case 'billing_temporarily_unavailable':
        return 'Billing is temporarily unavailable for your organization while a payment issue is reviewed.';
      case 'trial_already_used':
        return 'Your organization has already used its lifetime browser test.';
      default:
        return `Your ${decision.plan} plan allows ${decision.limit} of these; you are using ${decision.current}.`;
    }
  }

  private async auditDenial(
    decision: EntitlementDecision,
    request: EntitlementRequest,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: decision.organizationId,
        action: 'billing.entitlement_denied',
        resourceType: 'subscription',
        metadata: {
          kind: request.kind,
          reason: decision.reason,
          plan: decision.plan,
          current: decision.current,
          limit: decision.limit,
          catalogVersion: decision.catalogVersion,
          correlationId: decision.correlationId,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

export class PlanQuotaExceededError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('PLAN_LIMIT_EXCEEDED' as ApiErrorCode, message, HttpStatus.FORBIDDEN, details);
  }
}
