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
import { CreditBalanceStatusSchema } from '@voiceforge/shared';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

const CREDIT_SECONDS_PER_MINUTE = 60;
/** Window used to warn a customer that credit is about to expire. */
const CREDIT_EXPIRY_HORIZON_DAYS = 30;
const PURCHASED_PACK_SECONDS = 6_000;
const PURCHASED_PACK_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;

const IdentifierSchema = z.string().trim().min(1);
const IdempotencyKeySchema = z.string().trim().min(1).max(255);

const SubscriptionGrantInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    invoiceId: IdentifierSchema,
    includedMinutes: z.number().int().nonnegative(),
    periodEnd: z.date(),
    actorId: IdentifierSchema.optional(),
  })
  .strict();

const PurchasedGrantInputSchema = z
  .object({
    organizationId: IdentifierSchema,
    checkoutSessionId: IdentifierSchema,
    purchasedAt: z.date(),
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
    checkoutSessionId: IdentifierSchema,
    refundId: IdentifierSchema,
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
    lifetimeBrowserTestSecondsRemaining: z.number().int().nonnegative(),
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
    invoiceId: IdentifierSchema,
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
    invoiceId: IdentifierSchema,
    includedMinutes: z.number().int().nonnegative(),
    periodEnd: z.string().datetime(),
    priority: z.literal(10),
  })
  .passthrough();

const PurchasedGrantOperationSchema = z
  .object({
    kind: z.literal('purchased_grant'),
    organizationId: IdentifierSchema,
    checkoutSessionId: IdentifierSchema,
    bucketId: IdentifierSchema,
    sourceType: z.literal('purchased'),
    sourceId: IdentifierSchema,
    seconds: z.literal(PURCHASED_PACK_SECONDS),
    purchasedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    priority: z.literal(20),
    status: z.literal('active'),
  })
  .strict();

const PurchasedGrantReplayMetadataSchema = z
  .object({
    operation: PurchasedGrantOperationSchema,
    checkoutSessionId: IdentifierSchema,
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
    checkoutSessionId: IdentifierSchema,
    refundId: IdentifierSchema,
    bucketId: IdentifierSchema,
    sourceType: z.literal('purchased'),
    sourceId: IdentifierSchema,
    originalSeconds: z.literal(PURCHASED_PACK_SECONDS),
  })
  .strict();

const AutomaticPurchasedReversalReplayMetadataSchema = z
  .object({
    operation: PurchasedReversalOperationSchema,
    checkoutSessionId: IdentifierSchema,
    refundId: IdentifierSchema,
    originalSeconds: z.literal(PURCHASED_PACK_SECONDS),
    unusedSecondsRemoved: z.literal(PURCHASED_PACK_SECONDS),
    consumedOrReservedSeconds: z.literal(0),
    reviewReason: z.null(),
  })
  .strict();

const ManualReviewPurchasedReversalReplayMetadataSchema = z
  .object({
    operation: PurchasedReversalOperationSchema,
    checkoutSessionId: IdentifierSchema,
    refundId: IdentifierSchema,
    originalSeconds: z.literal(PURCHASED_PACK_SECONDS),
    unusedSecondsPreserved: z.number().int().nonnegative(),
    consumedOrReservedSeconds: z.number().int().positive(),
    reviewReason: IdentifierSchema,
  })
  .strict();

export type SubscriptionGrantInput = z.infer<typeof SubscriptionGrantInputSchema>;
export type PurchasedGrantInput = z.infer<typeof PurchasedGrantInputSchema>;
export type MinuteReservationInput = z.infer<typeof MinuteReservationInputSchema>;
export type CommitReservationInput = z.infer<typeof CommitReservationInputSchema>;
export type NextMinuteInput = z.infer<typeof NextMinuteInputSchema>;
export type ReleaseReservationInput = z.infer<typeof ReleaseReservationInputSchema>;
export type CreditReversalInput = z.infer<typeof CreditReversalInputSchema>;

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
  lifetimeBrowserTestSecondsRemaining: number;
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
    const idempotencyKey = `stripe:invoice:${input.invoiceId}:included`;

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const existing = await this.findIdempotentEntry(tx, input.organizationId, idempotencyKey);
      if (existing) {
        const bucket = await this.findReplaySourceBucket(
          tx,
          input.organizationId,
          'included',
          input.invoiceId,
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
            metadata.invoiceId === input.invoiceId &&
            metadata.includedMinutes === input.includedMinutes &&
            metadata.periodEnd === input.periodEnd.toISOString() &&
            metadata.priority === 10 &&
            metadata.operation.kind === 'subscription_grant' &&
            metadata.operation.organizationId === input.organizationId &&
            metadata.operation.invoiceId === input.invoiceId &&
            metadata.operation.bucketId === bucket.id &&
            metadata.operation.sourceType === 'included' &&
            metadata.operation.sourceId === input.invoiceId &&
            metadata.operation.seconds === seconds &&
            metadata.operation.periodEnd === input.periodEnd.toISOString() &&
            metadata.operation.priority === 10 &&
            metadata.operation.status === 'active' &&
            bucket.organizationId === input.organizationId &&
            bucket.sourceType === 'included' &&
            bucket.sourceId === input.invoiceId &&
            bucket.originalSeconds === seconds &&
            bucket.expiresAt.getTime() === input.periodEnd.getTime() &&
            bucket.priority === 10 &&
            bucket.status === 'active',
        });
        return this.buildCreditBalance(tx, lockedBalance);
      }

      const grantedAt = new Date();
      const bucket = await tx.billingCreditBucket.create({
        data: {
          organizationId: input.organizationId,
          sourceType: 'included',
          sourceId: input.invoiceId,
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
          actorType: 'stripe',
          actorId: input.actorId ?? input.invoiceId,
          reasonCode: 'subscription_included',
          idempotencyKey,
          metadata: this.jsonMetadata({
            operation: {
              kind: 'subscription_grant',
              organizationId: input.organizationId,
              invoiceId: input.invoiceId,
              bucketId: bucket.id,
              sourceType: 'included',
              sourceId: input.invoiceId,
              seconds,
              periodEnd: input.periodEnd.toISOString(),
              priority: 10,
              status: 'active',
            },
            invoiceId: input.invoiceId,
            includedMinutes: input.includedMinutes,
            periodEnd: input.periodEnd.toISOString(),
            priority: 10,
          }),
        },
      });

      return this.buildCreditBalance(tx, updatedBalance);
    });
  }

  async grantPurchasedCredits(rawInput: PurchasedGrantInput): Promise<CreditBalance> {
    const input = PurchasedGrantInputSchema.parse(rawInput);
    const idempotencyKey = `stripe:checkout:${input.checkoutSessionId}:topup`;

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const existing = await this.findIdempotentEntry(tx, input.organizationId, idempotencyKey);
      if (existing) {
        const expiresAt = new Date(input.purchasedAt.getTime() + PURCHASED_PACK_LIFETIME_MS);
        const bucket = await this.findReplaySourceBucket(
          tx,
          input.organizationId,
          'purchased',
          input.checkoutSessionId,
        );
        this.assertLedgerReplayIdentity(existing, {
          entryTypes: ['purchase_grant'],
          organizationId: input.organizationId,
          workspaceId: null,
          callId: null,
          bucketId: bucket.id,
          seconds: PURCHASED_PACK_SECONDS,
          reasonCode: 'purchased_topup',
          metadataSchema: PurchasedGrantReplayMetadataSchema,
          operationMatches: (metadata) =>
            metadata.checkoutSessionId === input.checkoutSessionId &&
            metadata.purchasedAt === input.purchasedAt.toISOString() &&
            metadata.expiresAt === expiresAt.toISOString() &&
            metadata.priority === 20 &&
            metadata.operation.kind === 'purchased_grant' &&
            metadata.operation.organizationId === input.organizationId &&
            metadata.operation.checkoutSessionId === input.checkoutSessionId &&
            metadata.operation.bucketId === bucket.id &&
            metadata.operation.sourceType === 'purchased' &&
            metadata.operation.sourceId === input.checkoutSessionId &&
            metadata.operation.seconds === PURCHASED_PACK_SECONDS &&
            metadata.operation.purchasedAt === input.purchasedAt.toISOString() &&
            metadata.operation.expiresAt === expiresAt.toISOString() &&
            metadata.operation.priority === 20 &&
            metadata.operation.status === 'active' &&
            bucket.organizationId === input.organizationId &&
            bucket.sourceType === 'purchased' &&
            bucket.sourceId === input.checkoutSessionId &&
            bucket.originalSeconds === PURCHASED_PACK_SECONDS &&
            bucket.validFrom.getTime() === input.purchasedAt.getTime() &&
            bucket.expiresAt.getTime() === expiresAt.getTime() &&
            bucket.priority === 20 &&
            bucket.status === 'active',
        });
        return this.buildCreditBalance(tx, lockedBalance);
      }

      const expiresAt = new Date(input.purchasedAt.getTime() + PURCHASED_PACK_LIFETIME_MS);
      const bucket = await tx.billingCreditBucket.create({
        data: {
          organizationId: input.organizationId,
          sourceType: 'purchased',
          sourceId: input.checkoutSessionId,
          originalSeconds: PURCHASED_PACK_SECONDS,
          remainingSeconds: PURCHASED_PACK_SECONDS,
          validFrom: input.purchasedAt,
          expiresAt,
          priority: 20,
          status: 'active',
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
          actorType: 'stripe',
          actorId: input.actorId ?? input.checkoutSessionId,
          reasonCode: 'purchased_topup',
          idempotencyKey,
          metadata: this.jsonMetadata({
            operation: {
              kind: 'purchased_grant',
              organizationId: input.organizationId,
              checkoutSessionId: input.checkoutSessionId,
              bucketId: bucket.id,
              sourceType: 'purchased',
              sourceId: input.checkoutSessionId,
              seconds: PURCHASED_PACK_SECONDS,
              purchasedAt: input.purchasedAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              priority: 20,
              status: 'active',
            },
            checkoutSessionId: input.checkoutSessionId,
            purchasedAt: input.purchasedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            priority: 20,
          }),
        },
      });

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

  async reversePurchasedCredits(rawInput: CreditReversalInput): Promise<CreditBalance> {
    const input = CreditReversalInputSchema.parse(rawInput);
    const idempotencyKey = `stripe:refund:${input.refundId}:topup_reversal`;

    return this.withLockedBalance(input.organizationId, async (tx, lockedBalance) => {
      const bucket = await tx.billingCreditBucket.findUnique({
        where: {
          organizationId_sourceType_sourceId: {
            organizationId: input.organizationId,
            sourceType: 'purchased',
            sourceId: input.checkoutSessionId,
          },
        },
      });
      if (!bucket) {
        throw new CreditLedgerInvariantError(
          `Purchased credit bucket ${input.checkoutSessionId} was not found for organization ${input.organizationId}`,
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
          `Purchased credit bucket ${input.checkoutSessionId} was already refunded by another operation`,
          'refund_already_processed',
        );
      }

      const unusedSeconds = bucket.remainingSeconds;
      const consumedOrReservedSeconds = bucket.originalSeconds - bucket.remainingSeconds;
      const reviewReason =
        consumedOrReservedSeconds > 0
          ? this.purchasedRefundReviewReason(input.checkoutSessionId, consumedOrReservedSeconds)
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
            actorType: 'stripe',
            actorId: input.refundId,
            reasonCode: 'refund_manual_review',
            idempotencyKey,
            metadata: this.jsonMetadata({
              operation: this.purchasedReversalOperation(input, bucket),
              checkoutSessionId: input.checkoutSessionId,
              refundId: input.refundId,
              originalSeconds: bucket.originalSeconds,
              unusedSecondsPreserved: unusedSeconds,
              consumedOrReservedSeconds,
              reviewReason,
            }),
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
          actorType: 'stripe',
          actorId: input.refundId,
          reasonCode: 'refund_unused_credit',
          idempotencyKey,
          metadata: this.jsonMetadata({
            operation: this.purchasedReversalOperation(input, bucket),
            checkoutSessionId: input.checkoutSessionId,
            refundId: input.refundId,
            originalSeconds: bucket.originalSeconds,
            unusedSecondsRemoved: unusedSeconds,
            consumedOrReservedSeconds,
            reviewReason: null,
          }),
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
    let lifetimeBrowserTestSecondsRemaining = 0;
    let expiringSeconds = 0;
    for (const bucket of buckets) {
      if (bucket.sourceType === 'included') includedSeconds += bucket.remainingSeconds;
      if (bucket.sourceType === 'lifetime_browser_test') {
        lifetimeBrowserTestSecondsRemaining += bucket.remainingSeconds;
      }
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
      lifetimeBrowserTestSecondsRemaining,
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
      lifetimeBrowserTestSecondsRemaining: secondsBySource.lifetime_browser_test ?? 0,
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
      lifetimeBrowserTestSecondsRemaining: balance.lifetimeBrowserTestSecondsRemaining,
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
      lifetimeBrowserTestSecondsRemaining: snapshot.lifetimeBrowserTestSecondsRemaining,
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
    input: CreditReversalInput,
  ): void {
    if (
      bucket.organizationId !== input.organizationId ||
      bucket.sourceType !== 'purchased' ||
      bucket.sourceId !== input.checkoutSessionId ||
      bucket.originalSeconds !== PURCHASED_PACK_SECONDS
    ) {
      throw new CreditLedgerInvariantError(
        'Purchased reversal bucket does not match immutable purchase identity',
        'idempotency_conflict',
      );
    }
  }

  private assertPurchasedReversalReplay(
    entry: BillingLedgerEntry,
    input: CreditReversalInput,
    bucket: BillingCreditBucket,
  ): void {
    if (entry.entryType === 'purchase_reversal') {
      this.assertLedgerReplayIdentity(entry, {
        entryTypes: ['purchase_reversal'],
        organizationId: input.organizationId,
        workspaceId: null,
        callId: null,
        bucketId: bucket.id,
        seconds: -PURCHASED_PACK_SECONDS,
        reasonCode: 'refund_unused_credit',
        metadataSchema: AutomaticPurchasedReversalReplayMetadataSchema,
        operationMatches: (metadata) =>
          this.purchasedReversalIdentityMatches(metadata.operation, input, bucket) &&
          metadata.checkoutSessionId === input.checkoutSessionId &&
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
          metadata.checkoutSessionId === input.checkoutSessionId &&
          metadata.refundId === input.refundId &&
          metadata.originalSeconds === bucket.originalSeconds &&
          metadata.unusedSecondsPreserved + metadata.consumedOrReservedSeconds ===
            metadata.originalSeconds &&
          metadata.reviewReason ===
            this.purchasedRefundReviewReason(
              input.checkoutSessionId,
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
    input: CreditReversalInput,
    bucket: BillingCreditBucket,
  ): boolean {
    return (
      operation.organizationId === input.organizationId &&
      operation.checkoutSessionId === input.checkoutSessionId &&
      operation.refundId === input.refundId &&
      operation.bucketId === bucket.id &&
      operation.sourceType === 'purchased' &&
      operation.sourceId === input.checkoutSessionId &&
      operation.originalSeconds === bucket.originalSeconds
    );
  }

  private purchasedRefundReviewReason(
    checkoutSessionId: string,
    consumedOrReservedSeconds: number,
  ): string {
    return `Purchased credit refund for checkout ${checkoutSessionId} could not reverse ${consumedOrReservedSeconds} consumed or reserved seconds; manual review required.`;
  }

  private purchasedReversalOperation(
    input: CreditReversalInput,
    bucket: BillingCreditBucket,
  ): z.infer<typeof PurchasedReversalOperationSchema> {
    return {
      kind: 'purchased_credit_reversal',
      organizationId: input.organizationId,
      checkoutSessionId: input.checkoutSessionId,
      refundId: input.refundId,
      bucketId: bucket.id,
      sourceType: 'purchased',
      sourceId: input.checkoutSessionId,
      originalSeconds: PURCHASED_PACK_SECONDS,
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
}
