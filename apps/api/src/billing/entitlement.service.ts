import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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
  VoicePipeline,
} from '@voiceforge/shared';
import {
  BILLING_CATALOG_VERSION,
  PlanTypeSchema,
  SubscriptionStatusSchema,
  getPlanEntitlements,
  isPipelineAllowed,
} from '@voiceforge/shared';
import { AppError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Dodo states that fund paid usage. Every other state — including `past_due`,
 * `unpaid`, `incomplete`, `incomplete_expired`, `paused`, and `canceled` — must
 * stop new paid work, because the organization has no confirmed revenue behind
 * it.
 */
const PAID_ACCESS_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

/**
 * How far past its stored `currentPeriodEnd` a subscription may still read as
 * funded.
 *
 * Dodo advances the period as soon as it charges the renewal, so a
 * healthy row is only momentarily behind — for as long as
 * `customer.subscription.updated`/`invoice.paid` is in flight. A row still
 * behind a day later is one whose renewal we cannot prove happened (a missed or
 * undelivered webhook), and it must stop funding paid work rather than reading
 * as `active` forever. The grace exists so a few minutes of webhook lag at
 * renewal never downgrades a paying customer.
 */
const PERIOD_END_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Derived from the shared contract rather than restated here, so a new plan or
 * Dodo status cannot be added to the schema without this service accepting
 * it.
 */
const PLAN_TYPES: ReadonlySet<string> = new Set<string>(PlanTypeSchema.options);

const SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set<string>(
  SubscriptionStatusSchema.options,
);

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
  private readonly logger = new Logger(EntitlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePlan(organizationId: string): Promise<EffectivePlan> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { organizationId },
      select: {
        plan: true,
        status: true,
        trialEnd: true,
        currentPeriodEnd: true,
        concurrentCallLimitOverride: true,
      },
    });

    const status = this.resolveStatus(organizationId, subscription?.status);
    const storedPlan = this.resolvePlan(subscription?.plan);
    const trialExpired =
      status === 'trialing' &&
      subscription?.trialEnd instanceof Date &&
      subscription.trialEnd.getTime() <= Date.now();
    // A paid plan name without a funding status is not paid access. An expired
    // trial, or a paid period that ended and was never renewed, falls all the
    // way back to Free so no downstream caller can read a paid entitlement from
    // a stale row. The period is only consulted for a row that would otherwise
    // have funded usage, so a long-canceled row does not log every time.
    const wouldFund = PAID_ACCESS_STATUSES.has(status) && !trialExpired && storedPlan !== 'free';
    const periodExpired =
      wouldFund && this.isPeriodExpired(organizationId, subscription?.currentPeriodEnd);
    const paidAccess = wouldFund && !periodExpired;
    const plan: PlanType = paidAccess ? storedPlan : 'free';

    return {
      organizationId,
      plan,
      status,
      catalogVersion: BILLING_CATALOG_VERSION,
      entitlements: this.resolveEntitlements(plan, subscription?.concurrentCallLimitOverride),
      paidAccess,
      periodExpired,
    };
  }

  /**
   * `effective` may be supplied by a caller that has already resolved the plan
   * for this operation. Reusing it removes a second subscription read and, more
   * importantly, guarantees both evaluations see the same commercial state
   * rather than two reads that can straddle a subscription update.
   */
  async check(
    organizationId: string,
    request: EntitlementRequest,
    effectivePlan?: EffectivePlan,
  ): Promise<EntitlementDecision> {
    const effective = effectivePlan ?? (await this.getEffectivePlan(organizationId));
    const correlationId = `ent_${randomUUID()}`;

    switch (request.kind) {
      case 'paid_call':
        return this.checkPaidCall(
          effective,
          request.minimumSeconds,
          correlationId,
          request.pipeline,
        );
      case 'browser_test':
        return this.checkBrowserTest(effective, request.minimumSeconds, correlationId);
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
      case 'phone_number_create':
        return this.checkQuota(
          effective,
          correlationId,
          request.current,
          effective.entitlements.phoneNumbers,
          'phone_number_limit_reached',
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

    try {
      await this.auditDenial(decision, request);
    } catch (error) {
      // Admission remains fail-closed with the intended quota response. Audit
      // storage failure is observable but must not turn a clean 403 into a 500.
      this.logger.error(
        `Failed to audit entitlement denial ${decision.correlationId} for organization ${organizationId}: ${(error as Error).message}`,
      );
    }
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
   * A browser test is a metered call funded by the organization's balance, on
   * whichever runtime its plan is entitled to.
   *
   * It used to be a one-time lifetime grant tracked by a `trialRedemption` row.
   * That is gone: Free now carries a recurring monthly allowance, and a browser
   * test is the only call a plan without PSTN can start, so a separate one-time
   * cap made the recurring allowance unspendable. Funding both from one balance
   * means the customer sees a single number and the ledger stays the only place
   * that decides whether a minute exists.
   *
   * The PSTN entitlement is deliberately not consulted here — that is exactly
   * what distinguishes a browser test from a telephony call on Free.
   */
  private async checkBrowserTest(
    effective: EffectivePlan,
    minimumSeconds: number,
    correlationId: string,
  ): Promise<EntitlementDecision> {
    return this.checkFundedCall(effective, minimumSeconds, correlationId, {
      // Free has no realtime entitlement, so a free test must be refused the
      // expensive runtime for the same reason a free telephony call would be.
      pipeline: this.testPipeline(effective),
    });
  }

  private async checkPaidCall(
    effective: EffectivePlan,
    minimumSeconds: number,
    correlationId: string,
    pipeline?: VoicePipeline,
  ): Promise<EntitlementDecision> {
    if (!effective.entitlements.outboundPstn || !effective.paidAccess) {
      return this.decision(effective, correlationId, {
        allowed: false,
        reason: this.unavailableReason(effective),
        current: 0,
        limit: minimumSeconds,
      });
    }

    return this.checkFundedCall(effective, minimumSeconds, correlationId, {
      ...(pipeline ? { pipeline } : {}),
    });
  }

  /**
   * The runtime a browser test would use. Free is entitled only to the in-house
   * pipeline, so its test is checked against that rather than against a runtime
   * it may never be routed to.
   */
  private testPipeline(effective: EffectivePlan): VoicePipeline {
    return isPipelineAllowed(effective.plan, 'realtime') ? 'realtime' : 'standard';
  }

  /**
   * Shared funding rule for every metered call: the plan must sell the runtime,
   * the balance must be healthy, and it must hold at least the minimum billable
   * amount. The pipeline is checked first because being refused a runtime the
   * plan does not sell is not a credit problem, and telling the customer to buy
   * minutes would not fix it.
   */
  private async checkFundedCall(
    effective: EffectivePlan,
    minimumSeconds: number,
    correlationId: string,
    options: { pipeline?: VoicePipeline },
  ): Promise<EntitlementDecision> {
    if (options.pipeline && !isPipelineAllowed(effective.plan, options.pipeline)) {
      return this.decision(effective, correlationId, {
        allowed: false,
        reason: 'pipeline_not_entitled',
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
    if (effective.status === 'unknown') return 'billing_temporarily_unavailable';
    // A lapsed period keeps `status` at `active` and downgrades `plan` to free,
    // so neither field can tell it apart from an organization that never
    // subscribed. Without this it reads as `subscription_required` — "subscribe
    // to continue" shown to someone who is already paying.
    if (effective.periodExpired) return 'subscription_inactive';
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

  /**
   * A `null` period is not an expiry: the checkout upsert creates the row before
   * Dodo reports a period, and a subscription event that omits it persists
   * null on purpose. Only a period that is genuinely in the past, by more than
   * {@link PERIOD_END_GRACE_MS}, revokes funding.
   */
  private isPeriodExpired(organizationId: string, currentPeriodEnd: Date | null | undefined): boolean {
    if (!(currentPeriodEnd instanceof Date)) return false;
    if (currentPeriodEnd.getTime() + PERIOD_END_GRACE_MS > Date.now()) return false;
    this.logger.warn(
      `Organization ${organizationId} has a subscription period that ended at ` +
        `${currentPeriodEnd.toISOString()} and was never renewed; refusing paid usage. ` +
        `A renewal webhook was probably missed.`,
    );
    return true;
  }

  /**
   * A stored status outside the shared contract is corruption, not a missing
   * subscription. Reporting it as `'none'` would tell a paying organization to
   * subscribe, so it is surfaced as `unknown` instead and every capability
   * check routes it to `billing_temporarily_unavailable`.
   */
  private resolveStatus(
    organizationId: string,
    status: string | undefined,
  ): EffectiveSubscriptionStatus {
    if (!status) return 'none';
    if (SUBSCRIPTION_STATUSES.has(status)) return status as EffectiveSubscriptionStatus;
    this.logger.error(
      `Organization ${organizationId} has unrecognized subscription status "${status}"; refusing paid usage until it is corrected.`,
    );
    return 'unknown';
  }

  private denialMessage(decision: EntitlementDecision): string {
    switch (decision.reason) {
      case 'subscription_required':
        return 'Your current plan does not include this capability. Upgrade to continue.';
      case 'subscription_inactive':
        return 'Your subscription is not active. Update your payment method to continue.';
      case 'credit_insufficient':
        // Minute packs are sold only to paid subscriptions, so telling a Free
        // organization to buy one describes a remedy it cannot act on. Its
        // allowance is recurring, so the honest options are waiting or upgrading.
        return decision.plan === 'free'
          ? 'Your organization has used its free minutes for this month. Upgrade to keep calling now, or wait for next month’s allowance.'
          : 'Your organization does not have enough call minutes. Buy a minute pack to continue.';
      case 'billing_temporarily_unavailable':
        return 'Billing is temporarily unavailable for your organization while a payment issue is reviewed.';
      case 'pipeline_not_entitled':
        return 'Your plan does not include this voice runtime. Upgrade to continue.';
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
