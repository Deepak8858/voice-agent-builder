import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type BillingLedgerEntry,
  type OrganizationCreditBalance,
} from '@prisma/client';
import type {
  CreditBalanceDto,
  EntitlementReason,
  RuntimeUsageDecision,
} from '@voiceforge/shared';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

const CREDIT_SECONDS_PER_MINUTE = 60;
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

const InitialReservationReplayMetadataSchema = z
  .object({
    operation: InitialReservationOperationSchema,
  })
  .passthrough();

const RuntimeDebitOperationSchema = z
  .object({
    kind: z.literal('next_minute_debit'),
    organizationId: IdentifierSchema,
    callId: IdentifierSchema,
    eventId: IdentifierSchema,
  })
  .strict();

const RuntimeDebitReplayMetadataSchema = z
  .object({
    operation: RuntimeDebitOperationSchema,
  })
  .passthrough();

const SubscriptionGrantOperationSchema = z
  .object({
    kind: z.literal('subscription_grant'),
    organizationId: IdentifierSchema,
    invoiceId: IdentifierSchema,
  })
  .strict();

const SubscriptionGrantReplayMetadataSchema = z
  .object({
    operation: SubscriptionGrantOperationSchema,
  })
  .passthrough();

const PurchasedGrantOperationSchema = z
  .object({
    kind: z.literal('purchased_grant'),
    organizationId: IdentifierSchema,
    checkoutSessionId: IdentifierSchema,
  })
  .strict();

const PurchasedGrantReplayMetadataSchema = z
  .object({
    operation: PurchasedGrantOperationSchema,
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
  })
  .passthrough();

const PurchasedReversalOperationSchema = z
  .object({
    kind: z.literal('purchased_credit_reversal'),
    organizationId: IdentifierSchema,
    checkoutSessionId: IdentifierSchema,
    refundId: IdentifierSchema,
    bucketId: IdentifierSchema,
  })
  .strict();

const PurchasedReversalReplayMetadataSchema = z
  .object({
    operation: PurchasedReversalOperationSchema,
  })
  .passthrough();

export type SubscriptionGrantInput = z.infer<
  typeof SubscriptionGrantInputSchema
>;
export type PurchasedGrantInput = z.infer<typeof PurchasedGrantInputSchema>;
export type MinuteReservationInput = z.infer<
  typeof MinuteReservationInputSchema
>;
export type CommitReservationInput = z.infer<
  typeof CommitReservationInputSchema
>;
export type NextMinuteInput = z.infer<typeof NextMinuteInputSchema>;
export type ReleaseReservationInput = z.infer<
  typeof ReleaseReservationInputSchema
>;
export type CreditReversalInput = z.infer<typeof CreditReversalInputSchema>;

export type ReservationAllocation = z.infer<
  typeof ReservationAllocationSchema
>;

export interface CreditBalance extends CreditBalanceDto {
  availableSeconds: number;
  reservedSeconds: number;
  totalOwnedSeconds: number;
  status: string;
  reviewReason: string | null;
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
  metadataSchema: z.ZodType<T>;
  operationMatches: (metadata: T) => boolean;
};

@Injectable()
export class CreditLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async grantSubscriptionCredits(
    rawInput: SubscriptionGrantInput,
  ): Promise<CreditBalance> {
    const input = SubscriptionGrantInputSchema.parse(rawInput);
    const seconds = input.includedMinutes * CREDIT_SECONDS_PER_MINUTE;
    const idempotencyKey = `stripe:invoice:${input.invoiceId}:included`;

    return this.withLockedBalance(
      input.organizationId,
      async (tx, lockedBalance) => {
        const existing = await this.findIdempotentEntry(
          tx,
          input.organizationId,
          idempotencyKey,
        );
        if (existing) {
          this.assertLedgerReplayIdentity(existing, {
            entryTypes: ['subscription_grant'],
            organizationId: input.organizationId,
            callId: null,
            metadataSchema: SubscriptionGrantReplayMetadataSchema,
            operationMatches: ({ operation }) =>
              operation.organizationId === input.organizationId &&
              operation.invoiceId === input.invoiceId,
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
              },
              invoiceId: input.invoiceId,
              includedMinutes: input.includedMinutes,
              periodEnd: input.periodEnd.toISOString(),
              priority: 10,
            }),
          },
        });

        return this.buildCreditBalance(tx, updatedBalance);
      },
    );
  }

  async grantPurchasedCredits(
    rawInput: PurchasedGrantInput,
  ): Promise<CreditBalance> {
    const input = PurchasedGrantInputSchema.parse(rawInput);
    const idempotencyKey = `stripe:checkout:${input.checkoutSessionId}:topup`;

    return this.withLockedBalance(
      input.organizationId,
      async (tx, lockedBalance) => {
        const existing = await this.findIdempotentEntry(
          tx,
          input.organizationId,
          idempotencyKey,
        );
        if (existing) {
          this.assertLedgerReplayIdentity(existing, {
            entryTypes: ['purchase_grant'],
            organizationId: input.organizationId,
            callId: null,
            metadataSchema: PurchasedGrantReplayMetadataSchema,
            operationMatches: ({ operation }) =>
              operation.organizationId === input.organizationId &&
              operation.checkoutSessionId === input.checkoutSessionId,
          });
          return this.buildCreditBalance(tx, lockedBalance);
        }

        const expiresAt = new Date(
          input.purchasedAt.getTime() + PURCHASED_PACK_LIFETIME_MS,
        );
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
              },
              checkoutSessionId: input.checkoutSessionId,
              purchasedAt: input.purchasedAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              priority: 20,
            }),
          },
        });

        return this.buildCreditBalance(tx, updatedBalance);
      },
    );
  }

  async reserveInitialMinute(
    rawInput: MinuteReservationInput,
  ): Promise<MinuteReservation> {
    const input = MinuteReservationInputSchema.parse(rawInput);

    return this.withLockedBalance(
      input.organizationId,
      async (tx, lockedBalance) => {
        await this.assertRuntimeScope(
          tx,
          input.organizationId,
          input.workspaceId,
          input.callId,
        );
        const existing = await this.findIdempotentEntry(
          tx,
          input.organizationId,
          input.idempotencyKey,
        );
        if (existing) {
          return this.replayInitialReservation(
            tx,
            lockedBalance,
            input,
            existing,
          );
        }

        const existingReservation = await this.findInitialReservationOrNull(
          tx,
          input.organizationId,
          input.callId,
        );
        if (existingReservation) {
          return this.replayInitialReservation(
            tx,
            lockedBalance,
            input,
            existingReservation,
          );
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
          return this.recordDeniedReservation(
            tx,
            lockedBalance,
            input,
            'credit_insufficient',
          );
        }

        await this.decrementAllocatedBuckets(
          tx,
          input.organizationId,
          allocations,
        );
        const updatedBalance = await tx.organizationCreditBalance.update({
          where: { organizationId: input.organizationId },
          data: {
            availableSeconds: { decrement: CREDIT_SECONDS_PER_MINUTE },
            reservedSeconds: { increment: CREDIT_SECONDS_PER_MINUTE },
            version: { increment: 1 },
          },
        });
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
          creditBalance: await this.buildCreditBalance(tx, updatedBalance),
        };
      },
    );
  }

  async commitReservation(
    rawInput: CommitReservationInput,
  ): Promise<CreditBalance> {
    const input = CommitReservationInputSchema.parse(rawInput);

    return this.withLockedBalance(
      input.organizationId,
      async (tx, lockedBalance) => {
        await this.assertCallScope(tx, input.organizationId, input.callId);
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

        const reservation = await this.findInitialReservation(
          tx,
          input.organizationId,
          input.callId,
        );
        const allocations = this.parseReservationAllocations(
          reservation.metadata,
        );
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
      },
    );
  }

  async reserveAndDebitNextMinute(
    rawInput: NextMinuteInput,
  ): Promise<RuntimeUsageDecision> {
    const input = NextMinuteInputSchema.parse(rawInput);

    return this.withLockedBalance(
      input.organizationId,
      async (tx, lockedBalance) => {
        await this.assertRuntimeScope(
          tx,
          input.organizationId,
          input.workspaceId,
          input.callId,
        );
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
            this.reasonFromLedger(
              existing.entryType,
              existing.reasonCode,
            ),
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
          return this.recordDeniedRuntimeDebit(
            tx,
            lockedBalance,
            input,
            'credit_insufficient',
          );
        }

        await this.decrementAllocatedBuckets(
          tx,
          input.organizationId,
          allocations,
        );
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
        return this.runtimeDecision(
          input,
          true,
          'allowed',
          1,
          creditBalance,
        );
      },
    );
  }

  async releaseReservation(
    rawInput: ReleaseReservationInput,
  ): Promise<CreditBalance> {
    const input = ReleaseReservationInputSchema.parse(rawInput);

    return this.withLockedBalance(
      input.organizationId,
      async (tx, lockedBalance) => {
        await this.assertCallScope(tx, input.organizationId, input.callId);
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

        const reservation = await this.findInitialReservation(
          tx,
          input.organizationId,
          input.callId,
        );
        const allocations = this.parseReservationAllocations(
          reservation.metadata,
        );
        const seconds = this.sumAllocations(allocations);
        if (lockedBalance.reservedSeconds < seconds) {
          throw new CreditLedgerInvariantError(
            `Reserved balance is insufficient to release call ${input.callId}`,
          );
        }

        await this.incrementAllocatedBuckets(
          tx,
          input.organizationId,
          allocations,
        );
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
      },
    );
  }

  async reversePurchasedCredits(
    rawInput: CreditReversalInput,
  ): Promise<CreditBalance> {
    const input = CreditReversalInputSchema.parse(rawInput);
    const idempotencyKey = `stripe:refund:${input.refundId}:topup_reversal`;

    return this.withLockedBalance(
      input.organizationId,
      async (tx, lockedBalance) => {
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
        const existing = await this.findIdempotentEntry(
          tx,
          input.organizationId,
          idempotencyKey,
        );
        if (existing) {
          this.assertLedgerReplayIdentity(existing, {
            entryTypes: [
              'purchase_reversal',
              'purchase_reversal_review',
            ],
            organizationId: input.organizationId,
            callId: null,
            bucketId: bucket.id,
            metadataSchema: PurchasedReversalReplayMetadataSchema,
            operationMatches: ({ operation }) =>
              operation.organizationId === input.organizationId &&
              operation.checkoutSessionId === input.checkoutSessionId &&
              operation.refundId === input.refundId &&
              operation.bucketId === bucket.id,
          });
          return this.buildCreditBalance(tx, lockedBalance);
        }
        if (bucket.status === 'refunded') {
          throw new CreditLedgerInvariantError(
            `Purchased credit bucket ${input.checkoutSessionId} was already refunded by another operation`,
            'refund_already_processed',
          );
        }

        const unusedSeconds = bucket.remainingSeconds;
        const consumedOrReservedSeconds =
          bucket.originalSeconds - bucket.remainingSeconds;
        const reviewReason =
          consumedOrReservedSeconds > 0
            ? `Purchased credit refund for checkout ${input.checkoutSessionId} could not reverse ${consumedOrReservedSeconds} consumed or reserved seconds; manual review required.`
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
                operation: this.purchasedReversalOperation(
                  input,
                  bucket.id,
                ),
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
              operation: this.purchasedReversalOperation(input, bucket.id),
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
      },
    );
  }

  async getBalance(organizationId: string): Promise<CreditBalance> {
    const validatedOrganizationId = IdentifierSchema.parse(organizationId);
    return this.withLockedBalance(
      validatedOrganizationId,
      (tx, lockedBalance) => this.buildCreditBalance(tx, lockedBalance),
    );
  }

  private async withLockedBalance<T>(
    organizationId: string,
    operation: (
      tx: TransactionClient,
      balance: OrganizationCreditBalance,
    ) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.organizationCreditBalance.upsert({
        where: { organizationId },
        create: { organizationId },
        update: {},
      });
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
  ): Promise<void> {
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
    const reservation = await this.findInitialReservationOrNull(
      tx,
      organizationId,
      callId,
    );
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

  private async recordDeniedReservation(
    tx: TransactionClient,
    balance: OrganizationCreditBalance,
    input: MinuteReservationInput,
    reason: Extract<
      EntitlementReason,
      'credit_insufficient' | 'billing_temporarily_unavailable'
    >,
  ): Promise<MinuteReservation> {
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
      creditBalance: await this.buildCreditBalance(tx, balance),
    };
  }

  private async recordDeniedRuntimeDebit(
    tx: TransactionClient,
    balance: OrganizationCreditBalance,
    input: NextMinuteInput,
    reason: Extract<
      EntitlementReason,
      'credit_insufficient' | 'billing_temporarily_unavailable'
    >,
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
    const secondsBySource = buckets.reduce<Record<string, number>>(
      (totals, bucket) => {
        totals[bucket.sourceType] =
          (totals[bucket.sourceType] ?? 0) + bucket.remainingSeconds;
        return totals;
      },
      {},
    );

    return {
      organizationId: balance.organizationId,
      includedMinutesRemaining: Math.floor(
        (secondsBySource.included ?? 0) / CREDIT_SECONDS_PER_MINUTE,
      ),
      purchasedMinutesRemaining: Math.floor(
        (secondsBySource.purchased ?? 0) / CREDIT_SECONDS_PER_MINUTE,
      ),
      lifetimeBrowserTestSecondsRemaining:
        secondsBySource.lifetime_browser_test ?? 0,
      availableSeconds: balance.availableSeconds,
      reservedSeconds: balance.reservedSeconds,
      totalOwnedSeconds: this.totalOwned(balance),
      status: balance.status,
      reviewReason: balance.reviewReason,
    };
  }

  private toCreditBalanceDto(balance: CreditBalance): CreditBalanceDto {
    return {
      organizationId: balance.organizationId,
      includedMinutesRemaining: balance.includedMinutesRemaining,
      purchasedMinutesRemaining: balance.purchasedMinutesRemaining,
      lifetimeBrowserTestSecondsRemaining:
        balance.lifetimeBrowserTestSecondsRemaining,
    };
  }

  private async replayInitialReservation(
    tx: TransactionClient,
    balance: OrganizationCreditBalance,
    input: MinuteReservationInput,
    entry: BillingLedgerEntry,
  ): Promise<MinuteReservation> {
    this.assertInitialReservationIdentity(entry, input);
    const allowed = entry.entryType === 'reservation';
    const allocations = allowed
      ? this.parseReservationAllocations(entry.metadata)
      : [];
    if (allowed) {
      const completedEntry =
        (await tx.billingLedgerEntry.findFirst({
          where: {
            organizationId: input.organizationId,
            callId: input.callId,
            entryType: 'reservation_commit',
          },
          orderBy: { createdAt: 'desc' },
        })) ??
        (await tx.billingLedgerEntry.findFirst({
          where: {
            organizationId: input.organizationId,
            callId: input.callId,
            entryType: 'reservation_release',
          },
          orderBy: { createdAt: 'desc' },
        }));
      if (completedEntry) {
        throw new CreditLedgerInvariantError(
          `Initial reservation for call ${input.callId} is already finalized`,
          'reservation_lifecycle_conflict',
        );
      }
    }
    return {
      organizationId: input.organizationId,
      callId: input.callId,
      allowed,
      reason: this.reasonFromLedger(entry.entryType, entry.reasonCode),
      seconds: this.sumAllocations(allocations),
      allocations,
      creditBalance: await this.buildCreditBalance(tx, balance),
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
      metadataSchema: InitialReservationReplayMetadataSchema,
      operationMatches: ({ operation }) =>
        operation.organizationId === input.organizationId &&
        operation.workspaceId === input.workspaceId &&
        operation.callId === input.callId,
    });
  }

  private assertRuntimeDebitIdentity(
    entry: BillingLedgerEntry,
    input: NextMinuteInput,
  ): void {
    this.assertLedgerReplayIdentity(entry, {
      entryTypes: ['usage_debit', 'usage_debit_denied'],
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      callId: input.callId,
      metadataSchema: RuntimeDebitReplayMetadataSchema,
      operationMatches: ({ operation }) =>
        operation.organizationId === input.organizationId &&
        operation.callId === input.callId &&
        operation.eventId === input.eventId,
    });
  }

  private assertReservationFinalizationReplay(
    entry: BillingLedgerEntry,
    organizationId: string,
    callId: string,
    entryType: 'reservation_commit' | 'reservation_release',
  ): void {
    this.assertLedgerReplayIdentity(entry, {
      entryTypes: [entryType],
      organizationId,
      callId,
      metadataSchema: ReservationFinalizationReplayMetadataSchema,
      operationMatches: ({ operation }) =>
        operation.kind === entryType &&
        operation.organizationId === organizationId &&
        operation.callId === callId,
    });
  }

  private assertLedgerReplayIdentity<T>(
    entry: BillingLedgerEntry,
    expected: LedgerReplayExpectation<T>,
  ): void {
    const parsed = expected.metadataSchema.safeParse(entry.metadata);
    const workspaceMatches =
      expected.workspaceId === undefined ||
      entry.workspaceId === expected.workspaceId;
    const bucketMatches =
      expected.bucketId === undefined || entry.bucketId === expected.bucketId;
    if (
      !expected.entryTypes.includes(entry.entryType) ||
      entry.organizationId !== expected.organizationId ||
      entry.callId !== expected.callId ||
      !workspaceMatches ||
      !bucketMatches ||
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
      callId: input.callId,
      eventId: input.eventId,
    };
  }

  private purchasedReversalOperation(
    input: CreditReversalInput,
    bucketId: string,
  ): z.infer<typeof PurchasedReversalOperationSchema> {
    return {
      kind: 'purchased_credit_reversal',
      organizationId: input.organizationId,
      checkoutSessionId: input.checkoutSessionId,
      refundId: input.refundId,
      bucketId,
    };
  }

  private parseReservationAllocations(
    metadata: Prisma.JsonValue | null,
  ): ReservationAllocation[] {
    const parsed = ReservationMetadataSchema.safeParse(metadata);
    if (!parsed.success) {
      throw new CreditLedgerInvariantError(
        'Reservation ledger metadata does not contain valid bucket allocations',
        'reservation_allocation_invalid',
      );
    }
    const allocations = parsed.data.allocations;
    if (this.sumAllocations(allocations) !== CREDIT_SECONDS_PER_MINUTE) {
      throw new CreditLedgerInvariantError(
        `Reservation allocations must total exactly ${CREDIT_SECONDS_PER_MINUTE} seconds`,
        'reservation_allocation_invalid',
      );
    }
    const bucketIds = new Set(
      allocations.map((allocation) => allocation.bucketId),
    );
    if (bucketIds.size !== allocations.length) {
      throw new CreditLedgerInvariantError(
        'Reservation allocations must contain unique bucket IDs',
        'reservation_allocation_invalid',
      );
    }
    return allocations;
  }

  private reasonFromLedger(
    entryType: string,
    reasonCode: string,
  ): EntitlementReason {
    if (
      (entryType === 'reservation' && reasonCode === 'initial_minute') ||
      (entryType === 'usage_debit' && reasonCode === 'minute_boundary')
    ) {
      return 'allowed';
    }
    if (
      entryType === 'reservation_denied' ||
      entryType === 'usage_debit_denied'
    ) {
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
    return allocations.reduce(
      (total, allocation) => total + allocation.seconds,
      0,
    );
  }

  private totalOwned(
    balance: Pick<
      OrganizationCreditBalance,
      'availableSeconds' | 'reservedSeconds'
    >,
  ): number {
    return balance.availableSeconds + balance.reservedSeconds;
  }

  private jsonMetadata(
    value: Record<string, Prisma.JsonValue>,
  ): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }
}
