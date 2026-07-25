import { Injectable } from '@nestjs/common';
import { Prisma, type OrganizationCreditBalance } from '@prisma/client';
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
  constructor(message: string) {
    super(message);
    this.name = CreditLedgerInvariantError.name;
  }
}

type TransactionClient = Prisma.TransactionClient;

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
        if (
          await this.findIdempotentEntry(
            tx,
            input.organizationId,
            idempotencyKey,
          )
        ) {
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
        if (
          await this.findIdempotentEntry(
            tx,
            input.organizationId,
            idempotencyKey,
          )
        ) {
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
        const existing = await this.findIdempotentEntry(
          tx,
          input.organizationId,
          input.idempotencyKey,
        );
        if (existing) {
          const allocations =
            existing.entryType === 'reservation'
              ? this.parseReservationAllocations(existing.metadata)
              : [];
          return {
            organizationId: input.organizationId,
            callId: input.callId,
            allowed: existing.entryType === 'reservation',
            reason: this.reasonFromLedger(existing.reasonCode),
            seconds: allocations.reduce(
              (total, allocation) => total + allocation.seconds,
              0,
            ),
            allocations,
            creditBalance: await this.buildCreditBalance(tx, lockedBalance),
          };
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
            metadata: this.jsonMetadata({ allocations }),
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
        const exactDuplicate = await this.findIdempotentEntry(
          tx,
          input.organizationId,
          input.idempotencyKey,
        );
        if (exactDuplicate) {
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
        const existing = await this.findIdempotentEntry(
          tx,
          input.organizationId,
          input.idempotencyKey,
        );
        if (existing) {
          const creditBalance = await this.buildCreditBalance(tx, lockedBalance);
          const allowed = existing.entryType === 'usage_debit';
          return this.runtimeDecision(
            input,
            allowed,
            this.reasonFromLedger(existing.reasonCode),
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
              eventId: input.eventId,
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
        const exactDuplicate = await this.findIdempotentEntry(
          tx,
          input.organizationId,
          input.idempotencyKey,
        );
        if (exactDuplicate) {
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
        if (
          await this.findIdempotentEntry(
            tx,
            input.organizationId,
            idempotencyKey,
          )
        ) {
          return this.buildCreditBalance(tx, lockedBalance);
        }

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
        if (bucket.status === 'refunded') {
          return this.buildCreditBalance(tx, lockedBalance);
        }

        const unusedSeconds = bucket.remainingSeconds;
        const consumedOrReservedSeconds =
          bucket.originalSeconds - bucket.remainingSeconds;
        if (lockedBalance.availableSeconds < unusedSeconds) {
          throw new CreditLedgerInvariantError(
            `Available balance cannot remove ${unusedSeconds} refunded seconds for organization ${input.organizationId}`,
          );
        }

        await this.updateScopedBucket(tx, input.organizationId, bucket.id, {
          remainingSeconds: 0,
          status: 'refunded',
        });
        const reviewReason =
          consumedOrReservedSeconds > 0
            ? `Purchased credit refund for checkout ${input.checkoutSessionId} could not reverse ${consumedOrReservedSeconds} consumed or reserved seconds; manual review required.`
            : null;
        const updatedBalance = await tx.organizationCreditBalance.update({
          where: { organizationId: input.organizationId },
          data: {
            availableSeconds: { decrement: unusedSeconds },
            version: { increment: 1 },
            ...(reviewReason
              ? {
                  status: 'blocked',
                  reviewReason,
                }
              : {}),
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
            reasonCode: reviewReason
              ? 'refund_manual_review'
              : 'refund_unused_credit',
            idempotencyKey,
            metadata: this.jsonMetadata({
              checkoutSessionId: input.checkoutSessionId,
              refundId: input.refundId,
              originalSeconds: bucket.originalSeconds,
              unusedSecondsRemoved: unusedSeconds,
              consumedOrReservedSeconds,
              reviewReason,
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
    const reservation = await tx.billingLedgerEntry.findFirst({
      where: {
        organizationId,
        callId,
        entryType: 'reservation',
        reasonCode: 'initial_minute',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!reservation) {
      throw new CreditLedgerInvariantError(
        `Initial reservation was not found for call ${callId}`,
      );
    }
    return reservation;
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
        metadata: this.jsonMetadata({ allocations: [] }),
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
          eventId: input.eventId,
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

  private parseReservationAllocations(
    metadata: Prisma.JsonValue | null,
  ): ReservationAllocation[] {
    const parsed = ReservationMetadataSchema.safeParse(metadata);
    if (!parsed.success) {
      throw new CreditLedgerInvariantError(
        'Reservation ledger metadata does not contain valid bucket allocations',
      );
    }
    return parsed.data.allocations;
  }

  private reasonFromLedger(reasonCode: string): EntitlementReason {
    if (reasonCode === 'credit_insufficient') return 'credit_insufficient';
    if (reasonCode === 'billing_temporarily_unavailable') {
      return 'billing_temporarily_unavailable';
    }
    return 'allowed';
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
