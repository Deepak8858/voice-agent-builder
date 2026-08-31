import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type BillingCreditBucket,
  type BillingLedgerEntry,
  type OrganizationCreditBalance,
} from '@prisma/client';
import type {
  CreditBalanceDto,
  CreditBalanceStatus,
  EntitlementReason,
  RuntimeUsageDecision,
} from '@voiceforge/shared';
import {
  CreditBalanceStatusSchema,
  FREE_MONTHLY_MINUTES,
  MINUTE_PACK,
} from '@voiceforge/shared';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

const CREDIT_SECONDS_PER_MINUTE = 60;
/** Window used to warn a customer that credit is about to expire. */
const CREDIT_EXPIRY_HORIZON_DAYS = 30;
/**
 * The size and lifetime of a pack are commercial terms, so they are derived
 * from the shared catalog rather than restated here. Only *new* purchases use
 * these values: an already-persisted bucket carries the terms it was sold
 * under, and every replay check compares against that bucket instead, so a
 * repriced pack cannot turn a historical purchase into an idempotency
 * conflict.
 */
const PURCHASED_PACK_SECONDS = MINUTE_PACK.minutes * CREDIT_SECONDS_PER_MINUTE;
const PURCHASED_PACK_LIFETIME_MS = MINUTE_PACK.expiresAfterDays * 24 * 60 * 60 * 1_000;

/**
 * The free plan's recurring monthly allowance. Like an invoice grant it lands in
 * the `included` bucket at priority 10, so it is always spent before purchased
 * credit and is forfeited — not rolled over — when the month ends.
 */
const FREE_MONTHLY_GRANT_SECONDS = FREE_MONTHLY_MINUTES * CREDIT_SECONDS_PER_MINUTE;

const MonthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const IdentifierSchema = z.string().trim().min(1);
const IdempotencyKeySchema = z.string().trim().min(1).max(255);

/**
 * The webhook delivery whose processing this grant *is*, identified by Standard
 * Webhooks' `webhook-id` header.
 *
 * A webhook handler used to grant credit in one transaction and mark its event
 * processed in another, so a crash between the two commits left a granted event
 * looking unprocessed and re-dispatched the whole handler on redelivery.
 * Passing the delivery id here moves the "processed" write inside the grant's own
 * transaction, which makes grant and acknowledgement commit or roll back
 * together. Optional because non-webhook callers (the free-credit worker,
 * backfills) have no delivery to acknowledge.
 */
const WebhookIdSchema = IdentifierSchema.optional();

const SubscriptionGrantInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    includedMinutes: z.number().int().nonnegative(),
    periodEnd: z.date(),
    actorId: IdentifierSchema.optional(),
    webhookId: WebhookIdSchema,
  })
  .strict();

const PurchasedGrantInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    /**
     * The Dodo payment that funded the pack. It is both the bucket's `sourceId`
     * and its `dodoPaymentId`, which is uniquely indexed, so a second bucket can
     * never be minted for one payment. Stripe needed two ids here — a Checkout
     * session and a PaymentIntent, which could diverge for one payment; Dodo has
     * one, so there is one field.
     */
    paymentId: IdentifierSchema,
    purchasedAt: z.date(),
    actorId: IdentifierSchema.optional(),
    webhookId: WebhookIdSchema,
  })
  .strict();

const FreeMonthlyGrantInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    /** UTC calendar month the allowance belongs to, as `YYYY-MM`. */
    monthKey: MonthKeySchema,
    actorId: IdentifierSchema.optional(),
  })
  .strict();

const MinuteReservationInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    callId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

const CommitReservationInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    callId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

const NextMinuteInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    callId: IdentifierSchema,
    eventId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

const ReleaseReservationInputSchema = CommitReservationInputSchema;

const CreditReversalInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    /**
     * The bucket's `sourceId`: the Dodo payment for a pack, the billing cycle's
     * grant key for a subscription period.
     */
    paymentId: IdentifierSchema,
    refundId: IdentifierSchema,
    /**
     * Which credit a refund takes back. Defaults to `purchased` so the pack
     * callers and every already-persisted reversal keep their exact meaning;
     * `included` reverses a refunded subscription period, which used to be
     * retained as usable service forever.
     */
    sourceType: z.enum(['purchased', 'included']).default('purchased'),
  })
  .strict();

const ReservationAllocationSchema = z
  .object({
    bucketId: IdentifierSchema,
    seconds: z.number().int().positive(),
  })
  .strict();

const ReservationMetadataSchema = z
  .object({
    allocations: z.array(ReservationAllocationSchema).min(1),
  })
  .passthrough();

const InitialReservationOperationSchema = z
  .object({
    kind: z.literal('initial_minute_reservation'),
    organizationId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    callId: IdentifierSchema,
  })
  .strict();

const CreditBalanceReplaySchema = z
  .object({
    organizationId: IdentifierSchema,
    includedMinutesRemaining: z.number().int().nonnegative(),
    purchasedMinutesRemaining: z.number().int().nonnegative(),
    availableSeconds: z.number().int().nonnegative(),
    reservedSeconds: z.number().int().nonnegative(),
    totalOwnedSeconds: z.number().int().nonnegative(),
    status: CreditBalanceStatusSchema,
    reviewReason: z.string().nullable(),
  })
  .strict();

const InitialReservationReplayMetadataSchema = z
  .object({
    operation: InitialReservationOperationSchema,
    allocations: z.array(ReservationAllocationSchema),
    creditBalance: CreditBalanceReplaySchema,
  })
  .passthrough();

const RuntimeDebitOperationSchema = z
  .object({
    kind: z.literal('next_minute_debit'),
    organizationId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    callId: IdentifierSchema,
    eventId: IdentifierSchema,
  })
  .strict();

const RuntimeDebitReplayMetadataSchema = z
  .object({
    operation: RuntimeDebitOperationSchema,
    allocations: z.array(ReservationAllocationSchema),
  })
  .passthrough();

const SubscriptionGrantOperationSchema = z
  .object({
    kind: z.literal('subscription_grant'),
    organizationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    bucketId: IdentifierSchema,
    sourceType: z.literal('included'),
    sourceId: IdentifierSchema,
    seconds: z.number().int().nonnegative(),
    periodEnd: z.string().datetime(),
    priority: z.literal(10),
    status: z.literal('active'),
  })
  .strict();

const SubscriptionGrantReplayMetadataSchema = z
  .object({
    operation: SubscriptionGrantOperationSchema,
    paymentId: IdentifierSchema,
    includedMinutes: z.number().int().nonnegative(),
    periodEnd: z.string().datetime(),
    priority: z.literal(10),
  })
  .passthrough();

const FreeMonthlyGrantOperationSchema = z
  .object({
    kind: z.literal('free_monthly_grant'),
    organizationId: IdentifierSchema,
    monthKey: MonthKeySchema,
    bucketId: IdentifierSchema,
    sourceType: z.literal('included'),
    sourceId: IdentifierSchema,
    seconds: z.number().int().positive(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    priority: z.literal(10),
    status: z.literal('active'),
  })
  .strict();

const FreeMonthlyGrantReplayMetadataSchema = z
  .object({
    operation: FreeMonthlyGrantOperationSchema,
    monthKey: MonthKeySchema,
    includedMinutes: z.number().int().positive(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    priority: z.literal(10),
  })
  .passthrough();

const PurchasedGrantOperationSchema = z
  .object({
    kind: z.literal('purchased_grant'),
    organizationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    bucketId: IdentifierSchema,
    sourceType: z.literal('purchased'),
    sourceId: IdentifierSchema,
    seconds: z.number().int().positive(),
    purchasedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    priority: z.literal(20),
    status: z.literal('active'),
  })
  .strict();

const PurchasedGrantReplayMetadataSchema = z
  .object({
    operation: PurchasedGrantOperationSchema,
    paymentId: IdentifierSchema,
    purchasedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    priority: z.literal(20),
  })
  .passthrough();

const ReservationFinalizationOperationSchema = z
  .object({
    kind: z.enum(['reservation_commit', 'reservation_release']),
    organizationId: IdentifierSchema,
    callId: IdentifierSchema,
    reservationIdempotencyKey: IdempotencyKeySchema,
  })
  .strict();

const ReservationFinalizationReplayMetadataSchema = z
  .object({
    operation: ReservationFinalizationOperationSchema,
    reservationIdempotencyKey: IdempotencyKeySchema,
    allocations: z.array(ReservationAllocationSchema).min(1),
  })
  .passthrough();

const PurchasedReversalOperationSchema = z
  .object({
    kind: z.literal('purchased_credit_reversal'),
    organizationId: IdentifierSchema,
    paymentId: IdentifierSchema,
    refundId: IdentifierSchema,
    bucketId: IdentifierSchema,
    // Widened from a `purchased` literal when subscription reversals were added.
    // Widening is backward compatible: every already-persisted reversal recorded
    // `purchased`, which the enum still accepts.
    sourceType: z.enum(['purchased', 'included']),
    sourceId: IdentifierSchema,
    originalSeconds: z.number().int().positive(),
  })
  .strict();

const AutomaticPurchasedReversalReplayMetadataSchema = z
  .object({
    operation: PurchasedReversalOperationSchema,
    paymentId: IdentifierSchema,
    refundId: IdentifierSchema,
    originalSeconds: z.number().int().positive(),
    unusedSecondsRemoved: z.number().int().positive(),
    consumedOrReservedSeconds: z.literal(0),
    reviewReason: z.null(),
  })
  .strict();

const ManualReviewPurchasedReversalReplayMetadataSchema = z
  .object({
    operation: PurchasedReversalOperationSchema,
    paymentId: IdentifierSchema,
    refundId: IdentifierSchema,
    originalSeconds: z.number().int().positive(),
    unusedSecondsPreserved: z.number().int().nonnegative(),
    consumedOrReservedSeconds: z.number().int().positive(),
    reviewReason: IdentifierSchema,
  })
  .strict();

export type SubscriptionGrantInput = z.infer<typeof SubscriptionGrantInputSchema>;
export type PurchasedGrantInput = z.infer<typeof PurchasedGrantInputSchema>;
export type FreeMonthlyGrantInput = z.infer<typeof FreeMonthlyGrantInputSchema>;
export type MinuteReservationInput = z.infer<typeof MinuteReservationInputSchema>;
export type CommitReservationInput = z.infer<typeof CommitReservationInputSchema>;
export type NextMinuteInput = z.infer<typeof NextMinuteInputSchema>;
export type ReleaseReservationInput = z.infer<typeof ReleaseReservationInputSchema>;
/** `z.input`, not `z.infer`: `sourceType` has a default, so callers may omit it. */
export type CreditReversalInput = z.input<typeof CreditReversalInputSchema>;
/** The same input after parsing, where the `sourceType` default has been applied. */
type ParsedCreditReversal = z.output<typeof CreditReversalInputSchema>;

export type ReservationAllocation = z.infer<typeof ReservationAllocationSchema>;

export interface CreditBalance extends CreditBalanceDto {
  availableSeconds: number;
  reservedSeconds: number;
  totalOwnedSeconds: number;
  status: CreditBalanceStatus;
  reviewReason: string | null;
}

/**
 * Seconds a customer can see on the billing page, reported by source. Minutes
 * are deliberately not used here: the ledger meters in seconds and rounding to
 * minutes before display loses the remainder that is actually spendable.
 */
export interface CreditSummary {
  organizationId: string;
  includedSeconds: number;
  purchasedSeconds: number;
  reservedSeconds: number;
  availableSeconds: number;
  expiringSeconds: number;
  status: CreditBalanceStatus;
  reviewReason: string | null;
}

/**
 * A stored balance status outside the shared contract is corruption, not a
 * healthy account. Mapping it to `review` fails closed: paid usage stops and
 * the account is surfaced to a human, instead of the corrupt value flowing to
 * the dashboard as if it were valid.
 */
function toCreditBalanceStatus(status: string): CreditBalanceStatus {
  const parsed = CreditBalanceStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : 'review';
}

export interface MinuteReservation {
  organizationId: string;
  callId: string;
  allowed: boolean;
  reason: EntitlementReason;
  seconds: number;
  allocations: ReservationAllocation[];
  creditBalance: CreditBalance;
}

export class CreditLedgerInvariantError extends Error {
  readonly code = 'credit_ledger_invariant';

  constructor(
    message: string,
    readonly reasonCode: string = 'credit_ledger_invariant',
  ) {
    super(message);
    this.name = CreditLedgerInvariantError.name;
  }
}

type TransactionClient = Prisma.TransactionClient;

type LedgerReplayExpectation<T> = {
  entryTypes: readonly string[];
  organizationId: string;
  callId: string | null;
  workspaceId?: string | null;
  bucketId?: string | null;
  seconds?: number;
  reasonCode?: string;
  metadataSchema: z.ZodType<T>;
  operationMatches: (metadata: T) => boolean;
};

@Injectable()
export class CreditLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async grantSubscriptionCredits(rawInput: SubscriptionGrantInput): Promise<CreditBalance> {
    const input = SubscriptionGrantInputSchema.parse(rawInput);
    const seconds = input.includedMinutes * CREDIT_SECONDS_PER_MINUTE;
    const idempotencyKey = `dodo:payment:${input.paymentId}:included`;

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const existing = await this.findIdempotentEntry(tx, input.organizationId, idempotencyKey);
      if (existing) {
        const bucket = await this.findReplaySourceBucket(
          tx,
          input.organizationId,
          'included',
          input.paymentId,
        );
        this.assertLedgerReplayIdentity(existing, {
          entryTypes: ['subscription_grant'],
          organizationId: input.organizationId,
          workspaceId: null,
          callId: null,
          bucketId: bucket.id,
          seconds,
          reasonCode: 'subscription_included',
          metadataSchema: SubscriptionGrantReplayMetadataSchema,
          operationMatches: (metadata) =>
            metadata.paymentId === input.paymentId &&
            metadata.includedMinutes === input.includedMinutes &&
            metadata.periodEnd === input.periodEnd.toISOString() &&
            metadata.priority === 10 &&
            metadata.operation.kind === 'subscription_grant' &&
            metadata.operation.organizationId === input.organizationId &&
            metadata.operation.paymentId === input.paymentId &&
            metadata.operation.bucketId === bucket.id &&
            metadata.operation.sourceType === 'included' &&
            metadata.operation.sourceId === input.paymentId &&
            metadata.operation.seconds === seconds &&
            metadata.operation.periodEnd === input.periodEnd.toISOString() &&
            metadata.operation.priority === 10 &&
            metadata.operation.status === 'active' &&
            bucket.organizationId === input.organizationId &&
            bucket.sourceType === 'included' &&
            bucket.sourceId === input.paymentId &&
            bucket.originalSeconds === seconds &&
            bucket.expiresAt.getTime() === input.periodEnd.getTime() &&
            // Deliberately no live `bucket.status` term. A mid-cycle plan change
            // runs `supersedeIncludedBuckets`, which expires this cycle's bucket —
            // so when Dodo redelivers *this* cycle's event for days afterwards, a
            // superseded bucket is a legitimate replay target, not a conflict.
            // Asserting it threw `idempotency_conflict`, and that rolled the
            // transaction back including `markWebhookEventProcessed`, so the event
            // never cleared and the retries never stopped. The recorded
            // `metadata.operation.status` above is the immutable identity check;
            // the live row is allowed to move on.
            bucket.priority === 10,
        });
        await this.markWebhookEventProcessed(tx, input.webhookId);
        return this.buildCreditBalance(tx, lockedBalance);
      }

      // Forfeit the outgoing allowance BEFORE the new one exists, so the query
      // cannot pick up the bucket it is about to create.
      await this.supersedeIncludedBuckets(tx, input.organizationId, lockedBalance, input.paymentId);
      const grantedAt = new Date();
      const bucket = await tx.billingCreditBucket.create({
        data: {
          organizationId: input.organizationId,
          sourceType: 'included',
          sourceId: input.paymentId,
          originalSeconds: seconds,
          remainingSeconds: seconds,
          validFrom: grantedAt,
          expiresAt: input.periodEnd,
          priority: 10,
          status: 'active',
        },
      });
      const updatedBalance = await tx.organizationCreditBalance.update({
        where: { organizationId: input.organizationId },
        data: {
          availableSeconds: { increment: seconds },
          version: { increment: 1 },
        },
      });
      await tx.billingLedgerEntry.create({
        data: {
          organizationId: input.organizationId,
          bucketId: bucket.id,
          workspaceId: null,
          callId: null,
          entryType: 'subscription_grant',
          seconds,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
          actorType: 'dodo',
          actorId: input.actorId ?? input.paymentId,
          reasonCode: 'subscription_included',
          idempotencyKey,
          metadata: this.jsonMetadata({
            operation: {
              kind: 'subscription_grant',
              organizationId: input.organizationId,
              paymentId: input.paymentId,
              bucketId: bucket.id,
              sourceType: 'included',
              sourceId: input.paymentId,
              seconds,
              periodEnd: input.periodEnd.toISOString(),
              priority: 10,
              status: 'active',
            },
            paymentId: input.paymentId,
            includedMinutes: input.includedMinutes,
            periodEnd: input.periodEnd.toISOString(),
            priority: 10,
          }),
        },
      });
      await this.auditMoneyMove(tx, {
        organizationId: input.organizationId,
        action: 'billing.credit_granted',
        resourceType: 'billing_credit_bucket',
        resourceId: bucket.id,
        metadata: {
          initiator: input.actorId ?? 'dodo_webhook',
          source: 'subscription_invoice',
          paymentId: input.paymentId,
          webhookId: input.webhookId ?? null,
          includedMinutes: input.includedMinutes,
          seconds,
          periodEnd: input.periodEnd.toISOString(),
          balanceAfterSeconds: this.totalOwned(updatedBalance),
        },
      });
      await this.markWebhookEventProcessed(tx, input.webhookId);

      return this.buildCreditBalance(tx, updatedBalance);
    });
  }

  /**
   * Forfeits every still-active `included` bucket before a new period's
   * allowance lands.
   *
   * A mid-cycle plan change makes the provider charge a second time inside one
   * billing period. The grant is keyed by payment, so it correctly refused to
   * double-grant *the same* payment — but the outgoing period's bucket was left
   * `active` with its unused balance intact and expiring at the old period end,
   * so the customer held two full allowances at once and the cheapest moment to
   * upgrade was the day before renewal.
   *
   * The free monthly allowance is `included` too and is forfeited by the same
   * sweep, deliberately: an organization that upgrades mid-month must not stack
   * the free grant on top of the paid one either.
   *
   * `remainingSeconds` on a bucket is by construction unreserved — a reservation
   * decrements the bucket and moves the projection from available to reserved —
   * so the forfeit only ever removes spendable credit, never seconds an in-flight
   * call is relying on.
   */
  private async supersedeIncludedBuckets(
    tx: TransactionClient,
    organizationId: string,
    lockedBalance: OrganizationCreditBalance,
    paymentId: string,
  ): Promise<void> {
    const outgoing = await tx.billingCreditBucket.findMany({
      where: { organizationId, sourceType: 'included', status: 'active' },
      select: { id: true, sourceId: true, remainingSeconds: true },
    });
    const forfeitedSeconds = outgoing.reduce((total, bucket) => total + bucket.remainingSeconds, 0);
    if (outgoing.length === 0) return;

    if (forfeitedSeconds > lockedBalance.availableSeconds) {
      throw new CreditLedgerInvariantError(
        `Superseding included buckets would forfeit ${forfeitedSeconds} seconds but only ` +
          `${lockedBalance.availableSeconds} are available for organization ${organizationId}`,
      );
    }
    for (const bucket of outgoing) {
      await this.updateScopedBucket(tx, organizationId, bucket.id, {
        remainingSeconds: 0,
        status: 'expired',
      });
    }
    const updatedBalance = await tx.organizationCreditBalance.update({
      where: { organizationId },
      data: {
        availableSeconds: { decrement: forfeitedSeconds },
        version: { increment: 1 },
      },
    });
    // Recorded even at zero seconds: "the previous allowance was retired here"
    // is the fact a plan-change dispute turns on, and a fully-spent bucket is the
    // most likely case of all.
    await tx.billingLedgerEntry.create({
      data: {
        organizationId,
        bucketId: null,
        workspaceId: null,
        callId: null,
        entryType: 'included_grant_superseded',
        seconds: -forfeitedSeconds,
        balanceAfterSeconds: this.totalOwned(updatedBalance),
        actorType: 'dodo',
        actorId: paymentId,
        reasonCode: 'included_period_superseded',
        idempotencyKey: `dodo:payment:${paymentId}:supersede`,
        metadata: this.jsonMetadata({
          operation: {
            kind: 'included_grant_superseded',
            organizationId,
            paymentId,
          },
          paymentId,
          forfeitedSeconds,
          supersededBuckets: outgoing.map((bucket) => ({
            bucketId: bucket.id,
            sourceId: bucket.sourceId,
            forfeitedSeconds: bucket.remainingSeconds,
          })),
        }),
      },
    });
    // The balance, not a bucket: the sweep retires however many included buckets
    // it finds, and the one thing every one of them changed is this projection.
    await this.auditMoneyMove(tx, {
      organizationId,
      action: 'billing.credit_superseded',
      resourceType: 'organization_credit_balance',
      resourceId: organizationId,
      metadata: {
        initiator: 'dodo_webhook',
        source: 'subscription_invoice',
        paymentId,
        forfeitedSeconds,
        supersededBucketIds: outgoing.map((bucket) => bucket.id),
        balanceAfterSeconds: this.totalOwned(updatedBalance),
      },
    });
  }

  /**
   * Marks the webhook delivery that drove this grant processed, inside the
   * grant's own transaction.
   *
   * `updateMany` with a `processedAt: null` guard rather than `update`: the row
   * is owned by the webhook service, so this must neither invent one nor
   * overwrite an acknowledgement another delivery already recorded.
   */
  private async markWebhookEventProcessed(
    tx: TransactionClient,
    webhookId: string | undefined,
  ): Promise<void> {
    if (!webhookId) return;
    await tx.dodoWebhookEvent.updateMany({
      where: { webhookId, processedAt: null },
      data: { processedAt: new Date(), processingStartedAt: null, errorMessage: null },
    });
  }

  /**
   * Grants the free plan's recurring monthly allowance.
   *
   * Keyed by calendar month rather than by an invoice, because a free
   * organization has no invoice to hang the grant off. The month key is the only
   * thing that makes the grant unique, so a cron that fires twice, a replica
   * that starts twice, and a boot-time sweep all converge on exactly one grant
   * per organization per month.
   *
   * The bucket expires at the end of its month: the free allowance is a monthly
   * allowance, not an accumulating balance, so unused minutes must not roll
   * over. Reconciliation's `expireBuckets` pass performs the forfeiture.
   */
  async grantFreeMonthlyCredits(rawInput: FreeMonthlyGrantInput): Promise<CreditBalance> {
    const input = FreeMonthlyGrantInputSchema.parse(rawInput);
    const { periodStart, periodEnd } = monthBounds(input.monthKey);
    const sourceId = freeMonthlyGrantKey(input.organizationId, input.monthKey);
    const idempotencyKey = sourceId;
    const seconds = FREE_MONTHLY_GRANT_SECONDS;

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const existing = await this.findIdempotentEntry(tx, input.organizationId, idempotencyKey);
      if (existing) {
        const bucket = await this.findReplaySourceBucket(
          tx,
          input.organizationId,
          'included',
          sourceId,
        );
        // Compared against the seconds the bucket was actually granted, not the
        // current catalog: changing FREE_MONTHLY_MINUTES must not turn every
        // historical month into an idempotency conflict.
        const grantedSeconds = bucket.originalSeconds;
        this.assertLedgerReplayIdentity(existing, {
          entryTypes: ['free_monthly_grant'],
          organizationId: input.organizationId,
          workspaceId: null,
          callId: null,
          bucketId: bucket.id,
          seconds: grantedSeconds,
          reasonCode: 'free_monthly_included',
          metadataSchema: FreeMonthlyGrantReplayMetadataSchema,
          operationMatches: (metadata) =>
            metadata.monthKey === input.monthKey &&
            metadata.periodStart === periodStart.toISOString() &&
            metadata.periodEnd === periodEnd.toISOString() &&
            metadata.priority === 10 &&
            metadata.operation.kind === 'free_monthly_grant' &&
            metadata.operation.organizationId === input.organizationId &&
            metadata.operation.monthKey === input.monthKey &&
            metadata.operation.bucketId === bucket.id &&
            metadata.operation.sourceType === 'included' &&
            metadata.operation.sourceId === sourceId &&
            metadata.operation.seconds === grantedSeconds &&
            metadata.operation.periodStart === periodStart.toISOString() &&
            metadata.operation.periodEnd === periodEnd.toISOString() &&
            metadata.operation.priority === 10 &&
            metadata.operation.status === 'active' &&
            bucket.organizationId === input.organizationId &&
            bucket.sourceType === 'included' &&
            bucket.sourceId === sourceId &&
            bucket.validFrom.getTime() === periodStart.getTime() &&
            bucket.expiresAt.getTime() === periodEnd.getTime() &&
            bucket.priority === 10,
        });
        return this.buildCreditBalance(tx, lockedBalance);
      }

      // One included allowance per period, in both directions.
      //
      // `supersedeIncludedBuckets` enforces that when a *paid* invoice lands: it
      // forfeits the free grant so an upgrade cannot stack the two. Nothing
      // enforced the reverse. An organization that paid for the period and then
      // lapsed reads as Free from `getEffectivePlan` (`paidAccess` false), so the
      // sweep granted it the free allowance on top of the paid bucket it still
      // holds for that same period — and because the worker also sweeps on every
      // boot, any mid-month deploy triggered it. Cancelling after burning the
      // paid allowance was a refill.
      //
      // Only a bucket that outlives `periodStart` can overlap this month, and the
      // sole free bucket that could is this month's own — already returned above
      // by the idempotency check — so anything left here is an invoice grant.
      // Spent buckets count: the allowance was received either way, which is
      // exactly what the supersede path assumes too.
      //
      // Deliberately no ledger entry for the skip: the only key available is
      // `sourceId`, and writing it would send the next run down the replay path
      // looking for a bucket that was never created.
      const overlappingPaid = await tx.billingCreditBucket.findMany({
        where: {
          organizationId: input.organizationId,
          sourceType: 'included',
          status: 'active',
          expiresAt: { gt: periodStart },
        },
        select: { id: true, sourceId: true },
      });
      if (overlappingPaid.some((candidate) => candidate.sourceId !== sourceId)) {
        return this.buildCreditBalance(tx, lockedBalance);
      }

      const bucket = await tx.billingCreditBucket.create({
        data: {
          organizationId: input.organizationId,
          sourceType: 'included',
          sourceId,
          originalSeconds: seconds,
          remainingSeconds: seconds,
          validFrom: periodStart,
          expiresAt: periodEnd,
          priority: 10,
          status: 'active',
        },
      });
      const updatedBalance = await tx.organizationCreditBalance.update({
        where: { organizationId: input.organizationId },
        data: {
          availableSeconds: { increment: seconds },
          version: { increment: 1 },
        },
      });
      await tx.billingLedgerEntry.create({
        data: {
          organizationId: input.organizationId,
          bucketId: bucket.id,
          workspaceId: null,
          callId: null,
          entryType: 'free_monthly_grant',
          seconds,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
          actorType: 'system',
          actorId: input.actorId ?? sourceId,
          reasonCode: 'free_monthly_included',
          idempotencyKey,
          metadata: this.jsonMetadata({
            operation: {
              kind: 'free_monthly_grant',
              organizationId: input.organizationId,
              monthKey: input.monthKey,
              bucketId: bucket.id,
              sourceType: 'included',
              sourceId,
              seconds,
              periodStart: periodStart.toISOString(),
              periodEnd: periodEnd.toISOString(),
              priority: 10,
              status: 'active',
            },
            monthKey: input.monthKey,
            includedMinutes: FREE_MONTHLY_MINUTES,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            priority: 10,
          }),
        },
      });
      await this.auditMoneyMove(tx, {
        organizationId: input.organizationId,
        action: 'billing.credit_granted',
        resourceType: 'billing_credit_bucket',
        resourceId: bucket.id,
        metadata: {
          initiator: input.actorId ?? 'free_credit_worker',
          source: 'free_monthly_allowance',
          monthKey: input.monthKey,
          sourceId,
          seconds,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          balanceAfterSeconds: this.totalOwned(updatedBalance),
        },
      });

      return this.buildCreditBalance(tx, updatedBalance);
    });
  }

  async grantPurchasedCredits(rawInput: PurchasedGrantInput): Promise<CreditBalance> {
    const input = PurchasedGrantInputSchema.parse(rawInput);
    const idempotencyKey = `dodo:payment:${input.paymentId}:topup`;

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const existing = await this.findIdempotentEntry(tx, input.organizationId, idempotencyKey);
      if (existing) {
        const bucket = await this.findReplaySourceBucket(
          tx,
          input.organizationId,
          'purchased',
          input.paymentId,
        );
        // A replay is checked against the terms this purchase was actually
        // sold under, held on the bucket, rather than against the current
        // catalog. Otherwise repricing the pack would make every historical
        // redelivery look like an idempotency conflict.
        const soldSeconds = bucket.originalSeconds;
        const soldExpiresAt = bucket.expiresAt;
        this.assertLedgerReplayIdentity(existing, {
          entryTypes: ['purchase_grant'],
          organizationId: input.organizationId,
          workspaceId: null,
          callId: null,
          bucketId: bucket.id,
          seconds: soldSeconds,
          reasonCode: 'purchased_topup',
          metadataSchema: PurchasedGrantReplayMetadataSchema,
          operationMatches: (metadata) =>
            metadata.paymentId === input.paymentId &&
            metadata.purchasedAt === input.purchasedAt.toISOString() &&
            metadata.expiresAt === soldExpiresAt.toISOString() &&
            metadata.priority === 20 &&
            metadata.operation.kind === 'purchased_grant' &&
            metadata.operation.organizationId === input.organizationId &&
            metadata.operation.paymentId === input.paymentId &&
            metadata.operation.bucketId === bucket.id &&
            metadata.operation.sourceType === 'purchased' &&
            metadata.operation.sourceId === input.paymentId &&
            metadata.operation.seconds === soldSeconds &&
            metadata.operation.purchasedAt === input.purchasedAt.toISOString() &&
            metadata.operation.expiresAt === soldExpiresAt.toISOString() &&
            metadata.operation.priority === 20 &&
            metadata.operation.status === 'active' &&
            bucket.organizationId === input.organizationId &&
            bucket.sourceType === 'purchased' &&
            bucket.sourceId === input.paymentId &&
            bucket.validFrom.getTime() === input.purchasedAt.getTime() &&
            bucket.priority === 20 &&
            // No live `bucket.status` term either, for the same reason as the
            // subscription grant: `reversePurchasedCredits` marks this bucket
            // `refunded` and reconciliation expires it at term, both of which a
            // redelivery of the original payment can legitimately arrive after.
            //
            // A bucket granted before this column existed carries null, and a
            // replay of its purchase must still be recognised as the same
            // purchase rather than reported as a conflict. A bucket that *does*
            // name a payment must name this one.
            (bucket.dodoPaymentId === null || bucket.dodoPaymentId === input.paymentId),
        });
        await this.markWebhookEventProcessed(tx, input.webhookId);
        return this.buildCreditBalance(tx, lockedBalance);
      }

      // Recognises a pack this organization has already been granted for this
      // payment under some *other* ledger key — a bucket carried over from the
      // Stripe era, or one granted before the key scheme changed. Without it the
      // create below collides with `credit_bucket_dodo_payment_id_uidx`, which
      // rolls the whole transaction back, acknowledgement included, so the
      // provider retries the delivery until it gives up.
      //
      // Scoped to the organization, so a payment belonging to another tenant is
      // never acknowledged here — it falls through to the create and the unique
      // index rejects it. The index stays as the backstop for anything this
      // lookup cannot see, and the `FOR UPDATE` in `withLockedBalance` serialises
      // same-org deliveries, so the lookup cannot race one.
      const funded = await tx.billingCreditBucket.findFirst({
        where: {
          organizationId: input.organizationId,
          dodoPaymentId: input.paymentId,
        },
        select: { id: true },
      });
      if (funded) {
        await this.markWebhookEventProcessed(tx, input.webhookId);
        return this.buildCreditBalance(tx, lockedBalance);
      }

      const expiresAt = new Date(input.purchasedAt.getTime() + PURCHASED_PACK_LIFETIME_MS);
      const bucket = await tx.billingCreditBucket.create({
        data: {
          organizationId: input.organizationId,
          sourceType: 'purchased',
          sourceId: input.paymentId,
          originalSeconds: PURCHASED_PACK_SECONDS,
          remainingSeconds: PURCHASED_PACK_SECONDS,
          validFrom: input.purchasedAt,
          expiresAt,
          priority: 20,
          status: 'active',
          // Unique. A second delivery of the same payment that slipped past both
          // checks above aborts here instead of granting a second paid-for pack.
          dodoPaymentId: input.paymentId,
        },
      });
      const updatedBalance = await tx.organizationCreditBalance.update({
        where: { organizationId: input.organizationId },
        data: {
          availableSeconds: { increment: PURCHASED_PACK_SECONDS },
          version: { increment: 1 },
        },
      });
      await tx.billingLedgerEntry.create({
        data: {
          organizationId: input.organizationId,
          bucketId: bucket.id,
          workspaceId: null,
          callId: null,
          entryType: 'purchase_grant',
          seconds: PURCHASED_PACK_SECONDS,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
          actorType: 'dodo',
          actorId: input.actorId ?? input.paymentId,
          reasonCode: 'purchased_topup',
          idempotencyKey,
          metadata: this.jsonMetadata({
            operation: {
              kind: 'purchased_grant',
              organizationId: input.organizationId,
              paymentId: input.paymentId,
              bucketId: bucket.id,
              sourceType: 'purchased',
              sourceId: input.paymentId,
              seconds: PURCHASED_PACK_SECONDS,
              purchasedAt: input.purchasedAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              priority: 20,
              status: 'active',
            },
            paymentId: input.paymentId,
            purchasedAt: input.purchasedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            priority: 20,
          }),
        },
      });
      await this.auditMoneyMove(tx, {
        organizationId: input.organizationId,
        action: 'billing.credit_granted',
        resourceType: 'billing_credit_bucket',
        resourceId: bucket.id,
        metadata: {
          initiator: input.actorId ?? 'dodo_webhook',
          source: 'dodo_payment',
          paymentId: input.paymentId,
          webhookId: input.webhookId ?? null,
          seconds: PURCHASED_PACK_SECONDS,
          purchasedAt: input.purchasedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          balanceAfterSeconds: this.totalOwned(updatedBalance),
        },
      });
      await this.markWebhookEventProcessed(tx, input.webhookId);

      return this.buildCreditBalance(tx, updatedBalance);
    });
  }

  async reserveInitialMinute(rawInput: MinuteReservationInput): Promise<MinuteReservation> {
    const input = MinuteReservationInputSchema.parse(rawInput);

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      await this.assertRuntimeScope(tx, input.organizationId, input.workspaceId, input.callId);
      const existing = await this.findIdempotentEntry(
        tx,
        input.organizationId,
        input.idempotencyKey,
      );
      if (existing) {
        return this.replayInitialReservation(input, existing);
      }

      const existingDecision = await this.findInitialReservationDecisionOrNull(
        tx,
        input.organizationId,
        input.callId,
      );
      if (existingDecision) {
        return this.replayInitialReservation(input, existingDecision);
      }

      if (lockedBalance.status !== 'active') {
        return this.recordDeniedReservation(
          tx,
          lockedBalance,
          input,
          'billing_temporarily_unavailable',
        );
      }

      const allocations = await this.selectAllocations(
        tx,
        input.organizationId,
        CREDIT_SECONDS_PER_MINUTE,
      );
      if (
        lockedBalance.availableSeconds < CREDIT_SECONDS_PER_MINUTE ||
        this.sumAllocations(allocations) < CREDIT_SECONDS_PER_MINUTE
      ) {
        return this.recordDeniedReservation(tx, lockedBalance, input, 'credit_insufficient');
      }

      await this.decrementAllocatedBuckets(tx, input.organizationId, allocations);
      const updatedBalance = await tx.organizationCreditBalance.update({
        where: { organizationId: input.organizationId },
        data: {
          availableSeconds: { decrement: CREDIT_SECONDS_PER_MINUTE },
          reservedSeconds: { increment: CREDIT_SECONDS_PER_MINUTE },
          version: { increment: 1 },
        },
      });
      const creditBalance = await this.buildCreditBalance(tx, updatedBalance);
      await tx.billingLedgerEntry.create({
        data: {
          organizationId: input.organizationId,
          bucketId: null,
          workspaceId: input.workspaceId,
          callId: input.callId,
          entryType: 'reservation',
          seconds: CREDIT_SECONDS_PER_MINUTE,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
          actorType: 'system',
          actorId: input.callId,
          reasonCode: 'initial_minute',
          idempotencyKey: input.idempotencyKey,
          metadata: this.jsonMetadata({
            operation: this.initialReservationOperation(input),
            allocations,
            creditBalance: { ...creditBalance },
          }),
        },
      });

      return {
        organizationId: input.organizationId,
        callId: input.callId,
        allowed: true,
        reason: 'allowed',
        seconds: CREDIT_SECONDS_PER_MINUTE,
        allocations,
        creditBalance,
      };
    });
  }

  async commitReservation(rawInput: CommitReservationInput): Promise<CreditBalance> {
    const input = CommitReservationInputSchema.parse(rawInput);

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const call = await this.assertCallScope(tx, input.organizationId, input.callId);
      const reservation = await this.findInitialReservation(tx, input.organizationId, input.callId);
      this.assertReservationWorkspaceIdentity(reservation, call.workspaceId);
      const allocations = this.assertPersistedInitialReservationIdentity(
        reservation,
        input.organizationId,
        call.workspaceId,
        input.callId,
      );
      const exactDuplicate = await this.findIdempotentEntry(
        tx,
        input.organizationId,
        input.idempotencyKey,
      );
      if (exactDuplicate) {
        this.assertReservationFinalizationReplay(
          exactDuplicate,
          input.organizationId,
          input.callId,
          'reservation_commit',
          reservation,
          allocations,
        );
        return this.buildCreditBalance(tx, lockedBalance);
      }

      const previousCommit = await tx.billingLedgerEntry.findFirst({
        where: {
          organizationId: input.organizationId,
          callId: input.callId,
          entryType: 'reservation_commit',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (previousCommit) {
        this.assertReservationFinalizationReplay(
          previousCommit,
          input.organizationId,
          input.callId,
          'reservation_commit',
          reservation,
          allocations,
        );
        return this.buildCreditBalance(tx, lockedBalance);
      }
      const previousRelease = await tx.billingLedgerEntry.findFirst({
        where: {
          organizationId: input.organizationId,
          callId: input.callId,
          entryType: 'reservation_release',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (previousRelease) {
        throw new CreditLedgerInvariantError(
          `Cannot commit released reservation for call ${input.callId}`,
        );
      }

      const seconds = this.sumAllocations(allocations);
      if (lockedBalance.reservedSeconds < seconds) {
        throw new CreditLedgerInvariantError(
          `Reserved balance is insufficient to commit call ${input.callId}`,
        );
      }

      const updatedBalance = await tx.organizationCreditBalance.update({
        where: { organizationId: input.organizationId },
        data: {
          reservedSeconds: { decrement: seconds },
          version: { increment: 1 },
        },
      });
      await tx.billingLedgerEntry.create({
        data: {
          organizationId: input.organizationId,
          bucketId: null,
          workspaceId: reservation.workspaceId,
          callId: input.callId,
          entryType: 'reservation_commit',
          seconds: -seconds,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
          actorType: 'system',
          actorId: input.callId,
          reasonCode: 'call_connected',
          idempotencyKey: input.idempotencyKey,
          metadata: this.jsonMetadata({
            operation: {
              kind: 'reservation_commit',
              organizationId: input.organizationId,
              callId: input.callId,
              reservationIdempotencyKey: reservation.idempotencyKey,
            },
            reservationIdempotencyKey: reservation.idempotencyKey,
            allocations,
          }),
        },
      });

      return this.buildCreditBalance(tx, updatedBalance);
    });
  }

  async reserveAndDebitNextMinute(rawInput: NextMinuteInput): Promise<RuntimeUsageDecision> {
    const input = NextMinuteInputSchema.parse(rawInput);

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      await this.assertRuntimeScope(tx, input.organizationId, input.workspaceId, input.callId);
      const existing = await this.findIdempotentEntry(
        tx,
        input.organizationId,
        input.idempotencyKey,
      );
      if (existing) {
        this.assertRuntimeDebitIdentity(existing, input);
        const creditBalance = await this.buildCreditBalance(tx, lockedBalance);
        const allowed = existing.entryType === 'usage_debit';
        return this.runtimeDecision(
          input,
          allowed,
          this.reasonFromLedger(existing.entryType, existing.reasonCode),
          allowed ? 1 : 0,
          creditBalance,
        );
      }

      if (lockedBalance.status !== 'active') {
        return this.recordDeniedRuntimeDebit(
          tx,
          lockedBalance,
          input,
          'billing_temporarily_unavailable',
        );
      }

      const allocations = await this.selectAllocations(
        tx,
        input.organizationId,
        CREDIT_SECONDS_PER_MINUTE,
      );
      if (
        lockedBalance.availableSeconds < CREDIT_SECONDS_PER_MINUTE ||
        this.sumAllocations(allocations) < CREDIT_SECONDS_PER_MINUTE
      ) {
        return this.recordDeniedRuntimeDebit(tx, lockedBalance, input, 'credit_insufficient');
      }

      await this.decrementAllocatedBuckets(tx, input.organizationId, allocations);
      const updatedBalance = await tx.organizationCreditBalance.update({
        where: { organizationId: input.organizationId },
        data: {
          availableSeconds: { decrement: CREDIT_SECONDS_PER_MINUTE },
          version: { increment: 1 },
        },
      });
      await tx.billingLedgerEntry.create({
        data: {
          organizationId: input.organizationId,
          bucketId: null,
          workspaceId: input.workspaceId,
          callId: input.callId,
          entryType: 'usage_debit',
          seconds: -CREDIT_SECONDS_PER_MINUTE,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
          actorType: 'system',
          actorId: input.callId,
          reasonCode: 'minute_boundary',
          idempotencyKey: input.idempotencyKey,
          metadata: this.jsonMetadata({
            operation: this.runtimeDebitOperation(input),
            allocations,
          }),
        },
      });

      const creditBalance = await this.buildCreditBalance(tx, updatedBalance);
      return this.runtimeDecision(input, true, 'allowed', 1, creditBalance);
    });
  }

  async releaseReservation(rawInput: ReleaseReservationInput): Promise<CreditBalance> {
    const input = ReleaseReservationInputSchema.parse(rawInput);

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const call = await this.assertCallScope(tx, input.organizationId, input.callId);
      const reservation = await this.findInitialReservation(tx, input.organizationId, input.callId);
      this.assertReservationWorkspaceIdentity(reservation, call.workspaceId);
      const allocations = this.assertPersistedInitialReservationIdentity(
        reservation,
        input.organizationId,
        call.workspaceId,
        input.callId,
      );
      const exactDuplicate = await this.findIdempotentEntry(
        tx,
        input.organizationId,
        input.idempotencyKey,
      );
      if (exactDuplicate) {
        this.assertReservationFinalizationReplay(
          exactDuplicate,
          input.organizationId,
          input.callId,
          'reservation_release',
          reservation,
          allocations,
        );
        return this.buildCreditBalance(tx, lockedBalance);
      }

      const previousRelease = await tx.billingLedgerEntry.findFirst({
        where: {
          organizationId: input.organizationId,
          callId: input.callId,
          entryType: 'reservation_release',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (previousRelease) {
        this.assertReservationFinalizationReplay(
          previousRelease,
          input.organizationId,
          input.callId,
          'reservation_release',
          reservation,
          allocations,
        );
        return this.buildCreditBalance(tx, lockedBalance);
      }
      const previousCommit = await tx.billingLedgerEntry.findFirst({
        where: {
          organizationId: input.organizationId,
          callId: input.callId,
          entryType: 'reservation_commit',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (previousCommit) {
        throw new CreditLedgerInvariantError(
          `Cannot release committed reservation for call ${input.callId}`,
        );
      }

      const seconds = this.sumAllocations(allocations);
      if (lockedBalance.reservedSeconds < seconds) {
        throw new CreditLedgerInvariantError(
          `Reserved balance is insufficient to release call ${input.callId}`,
        );
      }

      await this.incrementAllocatedBuckets(tx, input.organizationId, allocations);
      const updatedBalance = await tx.organizationCreditBalance.update({
        where: { organizationId: input.organizationId },
        data: {
          availableSeconds: { increment: seconds },
          reservedSeconds: { decrement: seconds },
          version: { increment: 1 },
        },
      });
      await tx.billingLedgerEntry.create({
        data: {
          organizationId: input.organizationId,
          bucketId: null,
          workspaceId: reservation.workspaceId,
          callId: input.callId,
          entryType: 'reservation_release',
          seconds,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
          actorType: 'system',
          actorId: input.callId,
          reasonCode: 'call_not_connected',
          idempotencyKey: input.idempotencyKey,
          metadata: this.jsonMetadata({
            operation: {
              kind: 'reservation_release',
              organizationId: input.organizationId,
              callId: input.callId,
              reservationIdempotencyKey: reservation.idempotencyKey,
            },
            reservationIdempotencyKey: reservation.idempotencyKey,
            allocations,
          }),
        },
      });

      return this.buildCreditBalance(tx, updatedBalance);
    });
  }

  /**
   * Takes back the credit a refunded or successfully-disputed payment bought.
   *
   * Reverses either source: a pack (`purchased`) or a refunded subscription
   * period (`included`, which used to be retained as usable service no matter
   * how much of the cycle was refunded). The two share every rule that matters
   * — one reversal per provider reversal id, no reversal of already-spent credit
   * without a human — so they share the implementation rather than a copy of it.
   */
  async reversePurchasedCredits(rawInput: CreditReversalInput): Promise<CreditBalance> {
    const input = CreditReversalInputSchema.parse(rawInput);
    const idempotencyKey =
      input.sourceType === 'included'
        ? `dodo:refund:${input.refundId}:included_reversal`
        : `dodo:refund:${input.refundId}:topup_reversal`;

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const bucket = await tx.billingCreditBucket.findUnique({
        where: {
          organizationId_sourceType_sourceId: {
            organizationId: input.organizationId,
            sourceType: input.sourceType,
            sourceId: input.paymentId,
          },
        },
      });
      if (!bucket) {
        throw new CreditLedgerInvariantError(
          `${input.sourceType} credit bucket ${input.paymentId} was not found for organization ${input.organizationId}`,
        );
      }
      this.assertPurchasedBucketIdentity(bucket, input);
      const existing = await this.findIdempotentEntry(tx, input.organizationId, idempotencyKey);
      if (existing) {
        this.assertPurchasedReversalReplay(existing, input, bucket);
        return this.buildCreditBalance(tx, lockedBalance);
      }
      if (bucket.status === 'refunded') {
        throw new CreditLedgerInvariantError(
          `Purchased credit bucket ${input.paymentId} was already refunded by another operation`,
          'refund_already_processed',
        );
      }

      const unusedSeconds = bucket.remainingSeconds;
      const consumedOrReservedSeconds = bucket.originalSeconds - bucket.remainingSeconds;
      const reviewReason =
        consumedOrReservedSeconds > 0
          ? this.purchasedRefundReviewReason(input.paymentId, consumedOrReservedSeconds)
          : null;

      if (reviewReason) {
        const blockedBalance = await tx.organizationCreditBalance.update({
          where: { organizationId: input.organizationId },
          data: {
            status: 'blocked',
            reviewReason,
            version: { increment: 1 },
          },
        });
        await tx.billingLedgerEntry.create({
          data: {
            organizationId: input.organizationId,
            bucketId: bucket.id,
            workspaceId: null,
            callId: null,
            entryType: 'purchase_reversal_review',
            seconds: 0,
            balanceAfterSeconds: this.totalOwned(blockedBalance),
            actorType: 'dodo',
            actorId: input.refundId,
            reasonCode: 'refund_manual_review',
            idempotencyKey,
            metadata: this.jsonMetadata({
              operation: this.purchasedReversalOperation(input, bucket),
              paymentId: input.paymentId,
              refundId: input.refundId,
              originalSeconds: bucket.originalSeconds,
              unusedSecondsPreserved: unusedSeconds,
              consumedOrReservedSeconds,
              reviewReason,
            }),
          },
        });
        // The balance is what this branch changed: the credit stays, the
        // organization is blocked until a human resolves it.
        await this.auditMoneyMove(tx, {
          organizationId: input.organizationId,
          action: 'billing.credit_reversal_blocked',
          resourceType: 'organization_credit_balance',
          resourceId: input.organizationId,
          metadata: {
            initiator: 'dodo_webhook',
            sourceType: input.sourceType,
            sourceId: input.paymentId,
            refundId: input.refundId,
            bucketId: bucket.id,
            originalSeconds: bucket.originalSeconds,
            unusedSecondsPreserved: unusedSeconds,
            consumedOrReservedSeconds,
            reviewReason,
            balanceAfterSeconds: this.totalOwned(blockedBalance),
          },
        });
        return this.buildCreditBalance(tx, blockedBalance);
      }

      if (lockedBalance.availableSeconds < unusedSeconds) {
        throw new CreditLedgerInvariantError(
          `Available balance cannot remove ${unusedSeconds} refunded seconds for organization ${input.organizationId}`,
        );
      }

      await this.updateScopedBucket(tx, input.organizationId, bucket.id, {
        remainingSeconds: 0,
        status: 'refunded',
      });
      const updatedBalance = await tx.organizationCreditBalance.update({
        where: { organizationId: input.organizationId },
        data: {
          availableSeconds: { decrement: unusedSeconds },
          version: { increment: 1 },
        },
      });
      await tx.billingLedgerEntry.create({
        data: {
          organizationId: input.organizationId,
          bucketId: bucket.id,
          workspaceId: null,
          callId: null,
          entryType: 'purchase_reversal',
          seconds: -unusedSeconds,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
          actorType: 'dodo',
          actorId: input.refundId,
          reasonCode: 'refund_unused_credit',
          idempotencyKey,
          metadata: this.jsonMetadata({
            operation: this.purchasedReversalOperation(input, bucket),
            paymentId: input.paymentId,
            refundId: input.refundId,
            originalSeconds: bucket.originalSeconds,
            unusedSecondsRemoved: unusedSeconds,
            consumedOrReservedSeconds,
            reviewReason: null,
          }),
        },
      });
      await this.auditMoneyMove(tx, {
        organizationId: input.organizationId,
        action: 'billing.credit_reversed',
        resourceType: 'billing_credit_bucket',
        resourceId: bucket.id,
        metadata: {
          initiator: 'dodo_webhook',
          sourceType: input.sourceType,
          sourceId: input.paymentId,
          refundId: input.refundId,
          originalSeconds: bucket.originalSeconds,
          secondsRemoved: unusedSeconds,
          consumedOrReservedSeconds,
          balanceAfterSeconds: this.totalOwned(updatedBalance),
        },
      });

      return this.buildCreditBalance(tx, updatedBalance);
    });
  }

  async getBalance(organizationId: string): Promise<CreditBalance> {
    const validatedOrganizationId = IdentifierSchema.parse(organizationId);
    return this.withLockedBalance(validatedOrganizationId, (tx, lockedBalance) =>
      this.buildCreditBalance(tx, lockedBalance),
    );
  }

  /**
   * Read-only view for the dashboard. It deliberately does not take the balance
   * row lock or create a projection row: displaying a balance must never block
   * an in-flight call, and an organization that has never been granted credit
   * simply has zero.
   */
  async getCreditSummary(
    organizationId: string,
    expiringWithinDays = CREDIT_EXPIRY_HORIZON_DAYS,
  ): Promise<CreditSummary> {
    const validatedOrganizationId = IdentifierSchema.parse(organizationId);
    const now = new Date();
    const horizon = new Date(now.getTime() + expiringWithinDays * 24 * 60 * 60 * 1_000);

    const [balance, buckets] = await Promise.all([
      this.prisma.organizationCreditBalance.findUnique({
        where: { organizationId: validatedOrganizationId },
        select: { availableSeconds: true, reservedSeconds: true, status: true, reviewReason: true },
      }),
      this.prisma.billingCreditBucket.findMany({
        where: {
          organizationId: validatedOrganizationId,
          status: 'active',
          validFrom: { lte: now },
          expiresAt: { gt: now },
          remainingSeconds: { gt: 0 },
        },
        select: { sourceType: true, remainingSeconds: true, expiresAt: true },
      }),
    ]);

    let includedSeconds = 0;
    let purchasedSeconds = 0;
    let expiringSeconds = 0;
    for (const bucket of buckets) {
      if (bucket.sourceType === 'included') includedSeconds += bucket.remainingSeconds;
      if (bucket.sourceType === 'purchased') {
        purchasedSeconds += bucket.remainingSeconds;
        if (bucket.expiresAt.getTime() <= horizon.getTime()) {
          expiringSeconds += bucket.remainingSeconds;
        }
      }
    }

    return {
      organizationId: validatedOrganizationId,
      includedSeconds,
      purchasedSeconds,
      reservedSeconds: balance?.reservedSeconds ?? 0,
      availableSeconds: balance?.availableSeconds ?? 0,
      expiringSeconds,
      status: balance ? toCreditBalanceStatus(balance.status) : 'active',
      reviewReason: balance?.reviewReason ?? null,
    };
  }

  private async withLockedBalance<T>(
    organizationId: string,
    operation: (tx: TransactionClient, balance: OrganizationCreditBalance) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Prisma's empty-update upsert may compile to a read followed by an insert,
      // which races when two first-time grants arrive together. PostgreSQL owns
      // the conflict handling so both transactions can proceed to the same lock.
      await tx.$executeRaw`
        INSERT INTO organization_credit_balances (id, organization_id, updated_at)
        VALUES (gen_random_uuid(), ${organizationId}::uuid, NOW())
        ON CONFLICT (organization_id) DO NOTHING
      `;
      await tx.$queryRaw`
        SELECT id
        FROM organization_credit_balances
        WHERE organization_id = ${organizationId}::uuid
        FOR UPDATE
      `;
      const lockedBalance = await tx.organizationCreditBalance.findUnique({
        where: { organizationId },
      });
      if (!lockedBalance) {
        throw new CreditLedgerInvariantError(
          `Credit balance projection was not found for organization ${organizationId}`,
        );
      }
      return operation(tx, lockedBalance);
    });
  }

  private async selectAllocations(
    tx: TransactionClient,
    organizationId: string,
    requestedSeconds: number,
  ): Promise<ReservationAllocation[]> {
    const now = new Date();
    const buckets = await tx.billingCreditBucket.findMany({
      where: {
        organizationId,
        status: 'active',
        validFrom: { lte: now },
        expiresAt: { gt: now },
        remainingSeconds: { gt: 0 },
      },
      orderBy: [{ priority: 'asc' }, { expiresAt: 'asc' }, { id: 'asc' }],
    });
    const allocations: ReservationAllocation[] = [];
    let unallocatedSeconds = requestedSeconds;
    for (const bucket of buckets) {
      if (unallocatedSeconds === 0) break;
      const seconds = Math.min(bucket.remainingSeconds, unallocatedSeconds);
      allocations.push({ bucketId: bucket.id, seconds });
      unallocatedSeconds -= seconds;
    }
    return allocations;
  }

  private async assertRuntimeScope(
    tx: TransactionClient,
    organizationId: string,
    workspaceId: string,
    callId: string,
  ): Promise<void> {
    const workspace = await tx.workspace.findFirst({
      where: { id: workspaceId, organizationId },
      select: { id: true },
    });
    if (!workspace) {
      throw new CreditLedgerInvariantError(
        `Workspace ${workspaceId} does not belong to organization ${organizationId}`,
        'tenant_scope_mismatch',
      );
    }
    const call = await tx.call.findFirst({
      where: { id: callId, organizationId, workspaceId },
      select: { id: true },
    });
    if (!call) {
      throw new CreditLedgerInvariantError(
        `Call ${callId} does not belong to workspace ${workspaceId} and organization ${organizationId}`,
        'tenant_scope_mismatch',
      );
    }
  }

  private async assertCallScope(
    tx: TransactionClient,
    organizationId: string,
    callId: string,
  ): Promise<{ id: string; workspaceId: string }> {
    const call = await tx.call.findFirst({
      where: { id: callId, organizationId },
      select: { id: true, workspaceId: true },
    });
    if (!call) {
      throw new CreditLedgerInvariantError(
        `Call ${callId} does not belong to organization ${organizationId}`,
        'tenant_scope_mismatch',
      );
    }
    const workspace = await tx.workspace.findFirst({
      where: { id: call.workspaceId, organizationId },
      select: { id: true },
    });
    if (!workspace) {
      throw new CreditLedgerInvariantError(
        `Call ${callId} references a workspace outside organization ${organizationId}`,
        'tenant_scope_mismatch',
      );
    }
    return call;
  }

  private assertReservationWorkspaceIdentity(
    reservation: BillingLedgerEntry,
    callWorkspaceId: string,
  ): void {
    if (reservation.workspaceId !== callWorkspaceId) {
      throw new CreditLedgerInvariantError(
        'Initial reservation workspace does not match the persisted call workspace',
        'idempotency_conflict',
      );
    }
  }

  private assertPersistedInitialReservationIdentity(
    reservation: BillingLedgerEntry,
    organizationId: string,
    workspaceId: string,
    callId: string,
  ): ReservationAllocation[] {
    if (!IdempotencyKeySchema.safeParse(reservation.idempotencyKey).success) {
      throw new CreditLedgerInvariantError(
        'Persisted initial reservation has an invalid idempotency key',
        'idempotency_conflict',
      );
    }
    const allocations = this.parseReservationAllocations(reservation.metadata);
    this.assertInitialReservationIdentity(reservation, {
      organizationId,
      workspaceId,
      callId,
      idempotencyKey: reservation.idempotencyKey,
    });
    if (reservation.entryType !== 'reservation') {
      throw new CreditLedgerInvariantError(
        'Reservation finalization requires an allowed initial reservation',
        'idempotency_conflict',
      );
    }
    return allocations;
  }

  private async decrementAllocatedBuckets(
    tx: TransactionClient,
    organizationId: string,
    allocations: ReservationAllocation[],
  ): Promise<void> {
    for (const allocation of allocations) {
      await this.updateScopedBucket(tx, organizationId, allocation.bucketId, {
        remainingSeconds: { decrement: allocation.seconds },
      });
    }
  }

  private async incrementAllocatedBuckets(
    tx: TransactionClient,
    organizationId: string,
    allocations: ReservationAllocation[],
  ): Promise<void> {
    for (const allocation of allocations) {
      await this.updateScopedBucket(tx, organizationId, allocation.bucketId, {
        remainingSeconds: { increment: allocation.seconds },
      });
    }
  }

  private async updateScopedBucket(
    tx: TransactionClient,
    organizationId: string,
    bucketId: string,
    data: Prisma.BillingCreditBucketUpdateManyMutationInput,
  ): Promise<void> {
    const result = await tx.billingCreditBucket.updateMany({
      where: { id: bucketId, organizationId },
      data,
    });
    if (result.count !== 1) {
      throw new CreditLedgerInvariantError(
        `Credit bucket ${bucketId} was not found for organization ${organizationId}`,
      );
    }
  }

  private async findInitialReservation(
    tx: TransactionClient,
    organizationId: string,
    callId: string,
  ) {
    const reservation = await this.findInitialReservationOrNull(tx, organizationId, callId);
    if (!reservation) {
      throw new CreditLedgerInvariantError(
        `Initial reservation was not found for call ${callId}`,
        'reservation_not_found',
      );
    }
    return reservation;
  }

  private async findInitialReservationOrNull(
    tx: TransactionClient,
    organizationId: string,
    callId: string,
  ): Promise<BillingLedgerEntry | null> {
    return tx.billingLedgerEntry.findFirst({
      where: {
        organizationId,
        callId,
        entryType: 'reservation',
        reasonCode: 'initial_minute',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findInitialReservationDecisionOrNull(
    tx: TransactionClient,
    organizationId: string,
    callId: string,
  ): Promise<BillingLedgerEntry | null> {
    const reservation = await this.findInitialReservationOrNull(tx, organizationId, callId);
    if (reservation) return reservation;
    return tx.billingLedgerEntry.findFirst({
      where: {
        organizationId,
        callId,
        entryType: 'reservation_denied',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findIdempotentEntry(
    tx: TransactionClient,
    organizationId: string,
    idempotencyKey: string,
  ) {
    return tx.billingLedgerEntry.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey,
        },
      },
    });
  }

  private async findReplaySourceBucket(
    tx: TransactionClient,
    organizationId: string,
    sourceType: 'included' | 'purchased',
    sourceId: string,
  ): Promise<BillingCreditBucket> {
    const bucket = await tx.billingCreditBucket.findUnique({
      where: {
        organizationId_sourceType_sourceId: {
          organizationId,
          sourceType,
          sourceId,
        },
      },
    });
    if (!bucket) {
      throw new CreditLedgerInvariantError(
        'Idempotent grant is missing its organization-scoped credit bucket',
        'idempotency_conflict',
      );
    }
    return bucket;
  }

  private async recordDeniedReservation(
    tx: TransactionClient,
    balance: OrganizationCreditBalance,
    input: MinuteReservationInput,
    reason: Extract<EntitlementReason, 'credit_insufficient' | 'billing_temporarily_unavailable'>,
  ): Promise<MinuteReservation> {
    const creditBalance = await this.buildCreditBalance(tx, balance);
    await tx.billingLedgerEntry.create({
      data: {
        organizationId: input.organizationId,
        bucketId: null,
        workspaceId: input.workspaceId,
        callId: input.callId,
        entryType: 'reservation_denied',
        seconds: 0,
        balanceAfterSeconds: this.totalOwned(balance),
        actorType: 'system',
        actorId: input.callId,
        reasonCode: reason,
        idempotencyKey: input.idempotencyKey,
        metadata: this.jsonMetadata({
          operation: this.initialReservationOperation(input),
          allocations: [],
          creditBalance: { ...creditBalance },
        }),
      },
    });
    return {
      organizationId: input.organizationId,
      callId: input.callId,
      allowed: false,
      reason,
      seconds: 0,
      allocations: [],
      creditBalance,
    };
  }

  private async recordDeniedRuntimeDebit(
    tx: TransactionClient,
    balance: OrganizationCreditBalance,
    input: NextMinuteInput,
    reason: Extract<EntitlementReason, 'credit_insufficient' | 'billing_temporarily_unavailable'>,
  ): Promise<RuntimeUsageDecision> {
    await tx.billingLedgerEntry.create({
      data: {
        organizationId: input.organizationId,
        bucketId: null,
        workspaceId: input.workspaceId,
        callId: input.callId,
        entryType: 'usage_debit_denied',
        seconds: 0,
        balanceAfterSeconds: this.totalOwned(balance),
        actorType: 'system',
        actorId: input.callId,
        reasonCode: reason,
        idempotencyKey: input.idempotencyKey,
        metadata: this.jsonMetadata({
          operation: this.runtimeDebitOperation(input),
          allocations: [],
        }),
      },
    });
    const creditBalance = await this.buildCreditBalance(tx, balance);
    return this.runtimeDecision(input, false, reason, 0, creditBalance);
  }

  private runtimeDecision(
    input: NextMinuteInput,
    allowed: boolean,
    reason: EntitlementReason,
    billableMinutes: number,
    balance: CreditBalance,
  ): RuntimeUsageDecision {
    return {
      eventId: input.eventId,
      callId: input.callId,
      organizationId: input.organizationId,
      allowed,
      reason,
      billableMinutes,
      creditBalance: this.toCreditBalanceDto(balance),
    };
  }

  private async buildCreditBalance(
    tx: TransactionClient,
    balance: OrganizationCreditBalance,
  ): Promise<CreditBalance> {
    const now = new Date();
    const buckets = await tx.billingCreditBucket.findMany({
      where: {
        organizationId: balance.organizationId,
        status: 'active',
        validFrom: { lte: now },
        expiresAt: { gt: now },
        remainingSeconds: { gt: 0 },
      },
      orderBy: [{ priority: 'asc' }, { expiresAt: 'asc' }, { id: 'asc' }],
    });
    const secondsBySource = buckets.reduce<Record<string, number>>((totals, bucket) => {
      totals[bucket.sourceType] = (totals[bucket.sourceType] ?? 0) + bucket.remainingSeconds;
      return totals;
    }, {});

    return {
      organizationId: balance.organizationId,
      includedMinutesRemaining: Math.floor(
        (secondsBySource.included ?? 0) / CREDIT_SECONDS_PER_MINUTE,
      ),
      purchasedMinutesRemaining: Math.floor(
        (secondsBySource.purchased ?? 0) / CREDIT_SECONDS_PER_MINUTE,
      ),
      availableSeconds: balance.availableSeconds,
      reservedSeconds: balance.reservedSeconds,
      totalOwnedSeconds: this.totalOwned(balance),
      status: toCreditBalanceStatus(balance.status),
      reviewReason: balance.reviewReason,
    };
  }

  private toCreditBalanceDto(balance: CreditBalance): CreditBalanceDto {
    return {
      organizationId: balance.organizationId,
      includedMinutesRemaining: balance.includedMinutesRemaining,
      purchasedMinutesRemaining: balance.purchasedMinutesRemaining,
    };
  }

  private replayInitialReservation(
    input: MinuteReservationInput,
    entry: BillingLedgerEntry,
  ): MinuteReservation {
    this.assertInitialReservationIdentity(entry, input);
    const metadata = InitialReservationReplayMetadataSchema.parse(entry.metadata);
    const allowed = entry.entryType === 'reservation';
    const allocations = allowed ? metadata.allocations : [];
    return {
      organizationId: input.organizationId,
      callId: input.callId,
      allowed,
      reason: this.reasonFromLedger(entry.entryType, entry.reasonCode),
      seconds: this.sumAllocations(allocations),
      allocations,
      creditBalance: this.snapshotToCreditBalance(metadata.creditBalance),
    };
  }

  /**
   * Rebuilds the balance field by field rather than passing the parsed snapshot
   * through. The schema's inferred shape marks every property optional under
   * the non-strict build config, so a direct assignment does not satisfy
   * {@link CreditBalance} there even though the schema requires each field.
   */
  private snapshotToCreditBalance(
    snapshot: z.infer<typeof CreditBalanceReplaySchema>,
  ): CreditBalance {
    return {
      organizationId: snapshot.organizationId,
      includedMinutesRemaining: snapshot.includedMinutesRemaining,
      purchasedMinutesRemaining: snapshot.purchasedMinutesRemaining,
      availableSeconds: snapshot.availableSeconds,
      reservedSeconds: snapshot.reservedSeconds,
      totalOwnedSeconds: snapshot.totalOwnedSeconds,
      status: snapshot.status,
      reviewReason: snapshot.reviewReason,
    };
  }

  private assertInitialReservationIdentity(
    entry: BillingLedgerEntry,
    input: MinuteReservationInput,
  ): void {
    this.assertLedgerReplayIdentity(entry, {
      entryTypes: ['reservation', 'reservation_denied'],
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      callId: input.callId,
      bucketId: null,
      metadataSchema: InitialReservationReplayMetadataSchema,
      operationMatches: ({ operation }) =>
        operation.organizationId === input.organizationId &&
        operation.workspaceId === input.workspaceId &&
        operation.callId === input.callId,
    });
    if (entry.idempotencyKey !== input.idempotencyKey) {
      throw new CreditLedgerInvariantError(
        'Initial reservation is bound to a different idempotency key',
        'idempotency_conflict',
      );
    }

    const metadata = InitialReservationReplayMetadataSchema.parse(entry.metadata);
    if (
      metadata.creditBalance.organizationId !== input.organizationId ||
      metadata.creditBalance.totalOwnedSeconds !==
        metadata.creditBalance.availableSeconds + metadata.creditBalance.reservedSeconds ||
      entry.balanceAfterSeconds !== metadata.creditBalance.totalOwnedSeconds
    ) {
      throw new CreditLedgerInvariantError(
        'Initial reservation replay balance snapshot is inconsistent with the ledger entry',
        'idempotency_conflict',
      );
    }
    if (entry.entryType === 'reservation') {
      if (entry.seconds !== CREDIT_SECONDS_PER_MINUTE) {
        throw new CreditLedgerInvariantError(
          'Initial reservation replay must contain exactly plus 60 seconds',
          'idempotency_conflict',
        );
      }
      this.reasonFromLedger(entry.entryType, entry.reasonCode);
      this.assertExactMinuteAllocations(
        metadata.allocations,
        'reservation_allocation_invalid',
        'Initial reservation',
      );
      return;
    }

    if (entry.seconds !== 0 || metadata.allocations.length !== 0) {
      throw new CreditLedgerInvariantError(
        'Denied initial reservation replay must have zero seconds and no allocations',
        'idempotency_conflict',
      );
    }
    this.reasonFromLedger(entry.entryType, entry.reasonCode);
  }

  private assertRuntimeDebitIdentity(entry: BillingLedgerEntry, input: NextMinuteInput): void {
    this.assertLedgerReplayIdentity(entry, {
      entryTypes: ['usage_debit', 'usage_debit_denied'],
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      callId: input.callId,
      bucketId: null,
      metadataSchema: RuntimeDebitReplayMetadataSchema,
      operationMatches: ({ operation }) =>
        operation.organizationId === input.organizationId &&
        operation.workspaceId === input.workspaceId &&
        operation.callId === input.callId &&
        operation.eventId === input.eventId,
    });
    const metadata = RuntimeDebitReplayMetadataSchema.parse(entry.metadata);
    if (entry.entryType === 'usage_debit') {
      const bucketIds = new Set(metadata.allocations.map((allocation) => allocation.bucketId));
      if (
        entry.seconds !== -CREDIT_SECONDS_PER_MINUTE ||
        metadata.allocations.length === 0 ||
        this.sumAllocations(metadata.allocations) !== CREDIT_SECONDS_PER_MINUTE ||
        bucketIds.size !== metadata.allocations.length
      ) {
        throw new CreditLedgerInvariantError(
          'Runtime debit replay does not contain an exact 60-second allocation identity',
          'idempotency_conflict',
        );
      }
      return;
    }

    if (entry.seconds !== 0 || metadata.allocations.length !== 0) {
      throw new CreditLedgerInvariantError(
        'Denied runtime debit replay must have zero seconds and no allocations',
        'idempotency_conflict',
      );
    }
  }

  private assertReservationFinalizationReplay(
    entry: BillingLedgerEntry,
    organizationId: string,
    callId: string,
    entryType: 'reservation_commit' | 'reservation_release',
    reservation: BillingLedgerEntry,
    reservationAllocations: ReservationAllocation[],
  ): void {
    this.assertLedgerReplayIdentity(entry, {
      entryTypes: [entryType],
      organizationId,
      workspaceId: reservation.workspaceId,
      callId,
      bucketId: null,
      seconds:
        entryType === 'reservation_commit' ? -CREDIT_SECONDS_PER_MINUTE : CREDIT_SECONDS_PER_MINUTE,
      reasonCode: entryType === 'reservation_commit' ? 'call_connected' : 'call_not_connected',
      metadataSchema: ReservationFinalizationReplayMetadataSchema,
      operationMatches: ({ operation, reservationIdempotencyKey }) =>
        operation.kind === entryType &&
        operation.organizationId === organizationId &&
        operation.callId === callId &&
        operation.reservationIdempotencyKey === reservation.idempotencyKey &&
        reservationIdempotencyKey === reservation.idempotencyKey,
    });
    const metadata = ReservationFinalizationReplayMetadataSchema.parse(entry.metadata);
    this.assertExactMinuteAllocations(
      metadata.allocations,
      'idempotency_conflict',
      'Reservation finalization',
    );
    if (!this.allocationsMatch(metadata.allocations, reservationAllocations)) {
      throw new CreditLedgerInvariantError(
        'Reservation finalization allocations do not match the persisted reservation',
        'idempotency_conflict',
      );
    }
  }

  private assertLedgerReplayIdentity<T>(
    entry: BillingLedgerEntry,
    expected: LedgerReplayExpectation<T>,
  ): void {
    const parsed = expected.metadataSchema.safeParse(entry.metadata);
    const workspaceMatches =
      expected.workspaceId === undefined || entry.workspaceId === expected.workspaceId;
    const bucketMatches = expected.bucketId === undefined || entry.bucketId === expected.bucketId;
    const secondsMatch = expected.seconds === undefined || entry.seconds === expected.seconds;
    const reasonMatches =
      expected.reasonCode === undefined || entry.reasonCode === expected.reasonCode;
    if (
      !expected.entryTypes.includes(entry.entryType) ||
      entry.organizationId !== expected.organizationId ||
      entry.callId !== expected.callId ||
      !workspaceMatches ||
      !bucketMatches ||
      !secondsMatch ||
      !reasonMatches ||
      !parsed.success ||
      !expected.operationMatches(parsed.data)
    ) {
      throw new CreditLedgerInvariantError(
        `Idempotency key is already bound to another credit operation`,
        'idempotency_conflict',
      );
    }
  }

  private initialReservationOperation(
    input: MinuteReservationInput,
  ): z.infer<typeof InitialReservationOperationSchema> {
    return {
      kind: 'initial_minute_reservation',
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      callId: input.callId,
    };
  }

  private runtimeDebitOperation(
    input: NextMinuteInput,
  ): z.infer<typeof RuntimeDebitOperationSchema> {
    return {
      kind: 'next_minute_debit',
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      callId: input.callId,
      eventId: input.eventId,
    };
  }

  private assertPurchasedBucketIdentity(
    bucket: BillingCreditBucket,
    input: ParsedCreditReversal,
  ): void {
    // `originalSeconds` is deliberately not compared to the current catalog:
    // a pack sold under earlier terms must still be refundable after the pack
    // size changes. It is instead treated as the authority every replay check
    // below is measured against.
    if (
      bucket.organizationId !== input.organizationId ||
      bucket.sourceType !== input.sourceType ||
      bucket.sourceId !== input.paymentId ||
      !Number.isInteger(bucket.originalSeconds) ||
      bucket.originalSeconds <= 0
    ) {
      throw new CreditLedgerInvariantError(
        'Reversal bucket does not match immutable purchase identity',
        'idempotency_conflict',
      );
    }
  }

  private assertPurchasedReversalReplay(
    entry: BillingLedgerEntry,
    input: ParsedCreditReversal,
    bucket: BillingCreditBucket,
  ): void {
    if (entry.entryType === 'purchase_reversal') {
      this.assertLedgerReplayIdentity(entry, {
        entryTypes: ['purchase_reversal'],
        organizationId: input.organizationId,
        workspaceId: null,
        callId: null,
        bucketId: bucket.id,
        seconds: -bucket.originalSeconds,
        reasonCode: 'refund_unused_credit',
        metadataSchema: AutomaticPurchasedReversalReplayMetadataSchema,
        operationMatches: (metadata) =>
          this.purchasedReversalIdentityMatches(metadata.operation, input, bucket) &&
          metadata.paymentId === input.paymentId &&
          metadata.refundId === input.refundId &&
          metadata.originalSeconds === bucket.originalSeconds &&
          metadata.unusedSecondsRemoved === bucket.originalSeconds &&
          metadata.consumedOrReservedSeconds === 0 &&
          metadata.reviewReason === null,
      });
      return;
    }

    if (entry.entryType === 'purchase_reversal_review') {
      this.assertLedgerReplayIdentity(entry, {
        entryTypes: ['purchase_reversal_review'],
        organizationId: input.organizationId,
        workspaceId: null,
        callId: null,
        bucketId: bucket.id,
        seconds: 0,
        reasonCode: 'refund_manual_review',
        metadataSchema: ManualReviewPurchasedReversalReplayMetadataSchema,
        operationMatches: (metadata) =>
          this.purchasedReversalIdentityMatches(metadata.operation, input, bucket) &&
          metadata.paymentId === input.paymentId &&
          metadata.refundId === input.refundId &&
          metadata.originalSeconds === bucket.originalSeconds &&
          metadata.unusedSecondsPreserved + metadata.consumedOrReservedSeconds ===
            metadata.originalSeconds &&
          metadata.reviewReason ===
            this.purchasedRefundReviewReason(
              input.paymentId,
              metadata.consumedOrReservedSeconds,
            ),
      });
      return;
    }

    throw new CreditLedgerInvariantError(
      'Refund idempotency key is bound to another ledger entry type',
      'idempotency_conflict',
    );
  }

  private purchasedReversalIdentityMatches(
    operation: z.infer<typeof PurchasedReversalOperationSchema>,
    input: ParsedCreditReversal,
    bucket: BillingCreditBucket,
  ): boolean {
    return (
      operation.organizationId === input.organizationId &&
      operation.paymentId === input.paymentId &&
      operation.refundId === input.refundId &&
      operation.bucketId === bucket.id &&
      operation.sourceType === input.sourceType &&
      operation.sourceId === input.paymentId &&
      operation.originalSeconds === bucket.originalSeconds
    );
  }

  private purchasedRefundReviewReason(
    paymentId: string,
    consumedOrReservedSeconds: number,
  ): string {
    return `Purchased credit refund for checkout ${paymentId} could not reverse ${consumedOrReservedSeconds} consumed or reserved seconds; manual review required.`;
  }

  private purchasedReversalOperation(
    input: ParsedCreditReversal,
    bucket: BillingCreditBucket,
  ): z.infer<typeof PurchasedReversalOperationSchema> {
    return {
      kind: 'purchased_credit_reversal',
      organizationId: input.organizationId,
      paymentId: input.paymentId,
      refundId: input.refundId,
      bucketId: bucket.id,
      sourceType: input.sourceType,
      sourceId: input.paymentId,
      originalSeconds: bucket.originalSeconds,
    };
  }

  private parseReservationAllocations(metadata: Prisma.JsonValue | null): ReservationAllocation[] {
    const parsed = ReservationMetadataSchema.safeParse(metadata);
    if (!parsed.success) {
      throw new CreditLedgerInvariantError(
        'Reservation ledger metadata does not contain valid bucket allocations',
        'reservation_allocation_invalid',
      );
    }
    const allocations = parsed.data.allocations;
    this.assertExactMinuteAllocations(allocations, 'reservation_allocation_invalid', 'Reservation');
    return allocations;
  }

  private assertExactMinuteAllocations(
    allocations: ReservationAllocation[],
    reasonCode: string,
    context: string,
  ): void {
    if (this.sumAllocations(allocations) !== CREDIT_SECONDS_PER_MINUTE) {
      throw new CreditLedgerInvariantError(
        `${context} allocations must total exactly ${CREDIT_SECONDS_PER_MINUTE} seconds`,
        reasonCode,
      );
    }
    const bucketIds = new Set(allocations.map((allocation) => allocation.bucketId));
    if (bucketIds.size !== allocations.length) {
      throw new CreditLedgerInvariantError(
        `${context} allocations must contain unique bucket IDs`,
        reasonCode,
      );
    }
  }

  private allocationsMatch(
    actual: ReservationAllocation[],
    expected: ReservationAllocation[],
  ): boolean {
    if (actual.length !== expected.length) return false;
    const secondsByBucket = new Map(
      expected.map((allocation) => [allocation.bucketId, allocation.seconds]),
    );
    return actual.every(
      (allocation) => secondsByBucket.get(allocation.bucketId) === allocation.seconds,
    );
  }

  private reasonFromLedger(entryType: string, reasonCode: string): EntitlementReason {
    if (
      (entryType === 'reservation' && reasonCode === 'initial_minute') ||
      (entryType === 'usage_debit' && reasonCode === 'minute_boundary')
    ) {
      return 'allowed';
    }
    if (entryType === 'reservation_denied' || entryType === 'usage_debit_denied') {
      if (reasonCode === 'credit_insufficient') return 'credit_insufficient';
      if (reasonCode === 'billing_temporarily_unavailable') {
        return 'billing_temporarily_unavailable';
      }
    }
    throw new CreditLedgerInvariantError(
      `Ledger entry ${entryType} has incompatible reason code ${reasonCode}`,
      'ledger_reason_invalid',
    );
  }

  private sumAllocations(allocations: ReservationAllocation[]): number {
    return allocations.reduce((total, allocation) => total + allocation.seconds, 0);
  }

  private totalOwned(
    balance: Pick<OrganizationCreditBalance, 'availableSeconds' | 'reservedSeconds'>,
  ): number {
    return balance.availableSeconds + balance.reservedSeconds;
  }

  private jsonMetadata(value: Record<string, Prisma.JsonValue>): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  /**
   * One audit row per money move, written as a statement of the caller's own
   * transaction.
   *
   * Deliberately `tx.auditLog.create` rather than `AuditService.log`: that
   * service holds its own client and commits independently, so a rolled-back
   * grant would still leave a row claiming credit was granted — and a grant that
   * committed before the process died would leave none at all, which is how the
   * webhook's post-grant audit writes can already lose the trail. Here the claim
   * and the money commit together or neither does (precedent:
   * retention.service.ts).
   *
   * `actorUserId` is always null: every path into this ledger is a Dodo
   * webhook or the free-credit worker, and `audit_logs.actor_user_id` has an FK
   * to `users`, so a provider or system identifier cannot be stored there. The
   * initiator is named in `metadata.initiator` instead (precedent:
   * scripts/flag-farmed-organizations.ts).
   *
   * Only called on paths that actually moved money. An idempotent replay returns
   * before reaching one of these, on purpose: a row per redelivery buries
   * the single row that records the grant.
   */
  private async auditMoneyMove(
    tx: TransactionClient,
    row: {
      organizationId: string;
      action: string;
      resourceType: 'billing_credit_bucket' | 'organization_credit_balance';
      resourceId: string;
      metadata: Record<string, Prisma.JsonValue>;
    },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        organizationId: row.organizationId,
        workspaceId: null,
        actorUserId: null,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        metadata: this.jsonMetadata(row.metadata),
      },
    });
  }
}

/**
 * The UTC calendar month a moment belongs to, as `YYYY-MM`.
 *
 * Deliberately UTC rather than server-local: the grant key must not change when
 * a replica runs in a different timezone, or the same month would be granted
 * twice under two different keys.
 */
export function currentMonthKey(now: Date = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

/** Half-open UTC bounds of a `YYYY-MM` month: `[periodStart, periodEnd)`. */
export function monthBounds(monthKey: string): { periodStart: Date; periodEnd: Date } {
  const parsed = MonthKeySchema.safeParse(monthKey);
  if (!parsed.success) {
    throw new CreditLedgerInvariantError(
      `Free monthly grant month key ${monthKey} is not a YYYY-MM calendar month`,
      'free_grant_month_invalid',
    );
  }
  const [year, month] = parsed.data.split('-').map(Number) as [number, number];
  return {
    periodStart: new Date(Date.UTC(year, month - 1, 1)),
    // Month 12 rolls to the next January; Date.UTC normalizes the overflow.
    periodEnd: new Date(Date.UTC(year, month, 1)),
  };
}

/**
 * Stable identity of one organization's allowance for one month, used as both
 * the bucket `sourceId` and the ledger idempotency key so the unique index on
 * each independently blocks a duplicate grant.
 */
export function freeMonthlyGrantKey(organizationId: string, monthKey: string): string {
  return `free_grant_${organizationId}_${monthKey}`;
}
