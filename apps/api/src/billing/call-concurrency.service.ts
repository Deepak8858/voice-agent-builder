import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

const IdentifierSchema = z.string().trim().min(1);
const AcquireSchema = z.object({
  callId: IdentifierSchema,
  organizationId: IdentifierSchema,
  organizationLimit: z.number().int().min(1).max(50),
}).strict();
const TokenInputSchema = z.object({
  callId: IdentifierSchema,
  organizationId: IdentifierSchema,
  leaseToken: IdentifierSchema,
}).strict();

export type AcquireCallLeaseInput = z.infer<typeof AcquireSchema>;
export type RenewCallLeaseInput = z.infer<typeof TokenInputSchema>;
export type ReleaseCallLeaseInput = z.infer<typeof TokenInputSchema>;
export type GrantedCallLease = { allowed: true; leaseToken: string; expiresAt: string };
export type RefusedCallLease = {
  allowed: false;
  reason: 'organization_concurrency_reached' | 'platform_concurrency_reached' | 'billing_temporarily_unavailable';
};
export type CallLeaseDecision = GrantedCallLease | RefusedCallLease;

/**
 * Narrows a lease decision to a refusal.
 *
 * Written as an explicit guard rather than an `if (!decision.allowed)` check
 * because the production build compiles with `strict` disabled
 * (`tsconfig.build.json`), and truthiness narrowing over boolean-literal
 * discriminants only works under `strictNullChecks`. A guard narrows in both
 * configurations, so the same source compiles for tests and for release.
 */
export function isLeaseRefused(decision: CallLeaseDecision): decision is RefusedCallLease {
  return decision.allowed === false;
}
export type LeaseRecoveryReport = { checked: number; recovered: number; failed: number };
export type LeaseRenewalReport = { checked: number; renewed: number; dropped: number };

/**
 * A lease is renewed once it is within this fraction of its TTL of expiring.
 * Renewing earlier wastes Redis round trips; renewing later risks the sweep
 * missing a lease between two runs.
 */
const RENEWAL_HORIZON_RATIO = 2;

/** Call statuses that mean the call is still up and still owes a lease. */
const IN_FLIGHT_CALL_STATUSES = ['queued', 'ringing', 'in_progress'] as const;

/**
 * Upper bound on leases replayed into Redis in one recovery pass. Bounds both
 * the memory held during boot and the size of the Redis pipeline.
 */
const LEASE_RECOVERY_BATCH_SIZE = 5_000;

const ACQUIRE_SCRIPT = `
local globalKey = KEYS[1]
local orgKey = KEYS[2]
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local callPrefix = ARGV[3] .. '|'
local member = callPrefix .. ARGV[4]
local globalLimit = tonumber(ARGV[5])
local orgLimit = tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', globalKey, '-inf', now)
redis.call('ZREMRANGEBYSCORE', orgKey, '-inf', now)
for _, existing in ipairs(redis.call('ZRANGE', orgKey, 0, -1)) do
  if string.sub(existing, 1, string.len(callPrefix)) == callPrefix then
    local score = redis.call('ZSCORE', orgKey, existing)
    return {'duplicate', existing, score}
  end
end
if redis.call('ZCARD', globalKey) >= globalLimit then return {'platform'} end
if redis.call('ZCARD', orgKey) >= orgLimit then return {'organization'} end
redis.call('ZADD', globalKey, expiresAt, member)
redis.call('ZADD', orgKey, expiresAt, member)
return {'allowed', member, tostring(expiresAt)}
`;

const RENEW_SCRIPT = `
local member = ARGV[1] .. '|' .. ARGV[2]
if not redis.call('ZSCORE', KEYS[1], member) or not redis.call('ZSCORE', KEYS[2], member) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], member)
redis.call('ZADD', KEYS[2], ARGV[3], member)
return 1
`;

const RELEASE_SCRIPT = `
local member = ARGV[1] .. '|' .. ARGV[2]
local removedGlobal = redis.call('ZREM', KEYS[1], member)
local removedOrg = redis.call('ZREM', KEYS[2], member)
return removedGlobal + removedOrg
`;

@Injectable()
export class CallConcurrencyService implements OnModuleInit {
  private readonly logger = new Logger(CallConcurrencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Redis holds the authoritative live count but is not durable. PostgreSQL
   * holds the durable record. After a Redis restart the ZSETs are empty while
   * calls are still running, so every in-flight lease is replayed into Redis
   * before this process admits anything. A failure here must not stop boot:
   * the reconciliation worker repeats the repair on its schedule.
   */
  async onModuleInit(): Promise<void> {
    try {
      const report = await this.recoverFromPostgres();
      if (report.checked > 0) {
        this.logger.log(
          `Recovered ${report.recovered}/${report.checked} concurrency leases into Redis (${report.failed} failed).`,
        );
      }
    } catch (err) {
      this.logger.error(`Concurrency lease recovery failed at startup: ${(err as Error).message}`);
    }
  }

  async acquire(rawInput: AcquireCallLeaseInput): Promise<CallLeaseDecision> {
    const input = AcquireSchema.parse(rawInput);
    const leaseToken = randomUUID();
    const now = Date.now();
    const expiresAtMs = now + env.BILLING_LEASE_TTL_SECONDS * 1_000;
    try {
      const result = await this.queue.getConnection().eval(
        ACQUIRE_SCRIPT,
        2,
        this.globalKey(),
        this.organizationKey(input.organizationId),
        String(now),
        String(expiresAtMs),
        input.callId,
        leaseToken,
        String(env.BILLING_GLOBAL_CONCURRENCY),
        String(input.organizationLimit),
      ) as string[];
      const state = result[0];
      if (state === 'platform') return { allowed: false, reason: 'platform_concurrency_reached' };
      if (state === 'organization') return { allowed: false, reason: 'organization_concurrency_reached' };
      const member = result[1];
      const score = Number(result[2]);
      if (!member || !Number.isFinite(score)) throw new Error('Invalid Redis lease response');
      const separator = member.lastIndexOf('|');
      const resolvedToken = member.slice(separator + 1);
      const expiresAt = new Date(score);
      // The call already holds a slot. Re-issuing a fresh token here would
      // admit the same call twice and overwrite the durable lease record, so
      // the existing lease is returned unchanged instead.
      if (state === 'duplicate') {
        return this.adoptExistingLease(input, resolvedToken, expiresAt);
      }
      try {
        await this.prisma.callConcurrencyLease.upsert({
          where: { callId: input.callId },
          create: {
            callId: input.callId,
            organizationId: input.organizationId,
            leaseToken: resolvedToken,
            state: 'active',
            expiresAt,
          },
          update: { leaseToken: resolvedToken, state: 'active', expiresAt },
        });
      } catch (err) {
        this.logger.error(
          `Durable lease write failed for call ${input.callId}: ${(err as Error).message}`,
        );
        await this.releaseRedis(input.callId, input.organizationId, resolvedToken).catch(() => undefined);
        return { allowed: false, reason: 'billing_temporarily_unavailable' };
      }
      return { allowed: true, leaseToken: resolvedToken, expiresAt: expiresAt.toISOString() };
    } catch (err) {
      this.logger.error(
        `Concurrency lease acquisition failed for call ${input.callId}: ${(err as Error).message}`,
      );
      return { allowed: false, reason: 'billing_temporarily_unavailable' };
    }
  }

  async renew(rawInput: RenewCallLeaseInput): Promise<boolean> {
    const input = TokenInputSchema.parse(rawInput);
    const expiresAt = new Date(Date.now() + env.BILLING_LEASE_TTL_SECONDS * 1_000);
    try {
      const renewed = Number(await this.queue.getConnection().eval(
        RENEW_SCRIPT,
        2,
        this.globalKey(),
        this.organizationKey(input.organizationId),
        input.callId,
        input.leaseToken,
        String(expiresAt.getTime()),
      )) === 1;
      if (!renewed) return false;
      const persisted = await this.prisma.callConcurrencyLease.updateMany({
        where: { callId: input.callId, organizationId: input.organizationId, leaseToken: input.leaseToken, state: 'active' },
        data: { expiresAt },
      });
      if (persisted.count !== 1) {
        await this.releaseRedis(input.callId, input.organizationId, input.leaseToken);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(
        `Concurrency lease renewal failed for call ${input.callId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  async release(rawInput: ReleaseCallLeaseInput): Promise<void> {
    const input = TokenInputSchema.parse(rawInput);
    try {
      await this.releaseRedis(input.callId, input.organizationId, input.leaseToken);
    } catch (err) {
      this.logger.error(
        `Redis lease release failed for call ${input.callId}: ${(err as Error).message}`,
      );
    }
    try {
      await this.prisma.callConcurrencyLease.updateMany({
        where: { callId: input.callId, organizationId: input.organizationId, leaseToken: input.leaseToken, state: 'active' },
        data: { state: 'released', expiresAt: new Date() },
      });
    } catch (err) {
      this.logger.error(
        `Durable lease release failed for call ${input.callId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Extends the leases of calls that are still running.
   *
   * `BILLING_LEASE_TTL_SECONDS` is capped at five minutes, so without this a
   * call longer than the TTL loses its concurrency slot: reconciliation
   * releases the expired lease, and the organization is then able to start more
   * concurrent calls than its plan allows while the original call is still up.
   *
   * Only leases attached to a call that is still in flight are renewed. A lease
   * whose call has completed or failed is deliberately left to expire, so a bug
   * in this sweep can only ever release capacity, never hold it forever. The
   * renewal itself is `renew()`, which already fails closed when Redis and
   * PostgreSQL disagree, and running the sweep twice simply pushes the same
   * expiry out twice.
   */
  async renewActiveLeases(limit: number): Promise<LeaseRenewalReport> {
    const now = Date.now();
    const horizon = new Date(now + (env.BILLING_LEASE_TTL_SECONDS * 1_000) / RENEWAL_HORIZON_RATIO);

    const due = await this.prisma.callConcurrencyLease.findMany({
      where: {
        state: 'active',
        expiresAt: { gt: new Date(now), lte: horizon },
        call: { status: { in: [...IN_FLIGHT_CALL_STATUSES] } },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: { callId: true, organizationId: true, leaseToken: true },
    });

    const report: LeaseRenewalReport = { checked: due.length, renewed: 0, dropped: 0 };
    for (const lease of due) {
      const renewed = await this.renew({
        callId: lease.callId,
        organizationId: lease.organizationId,
        leaseToken: lease.leaseToken,
      });
      if (renewed) {
        report.renewed += 1;
        continue;
      }
      report.dropped += 1;
      this.logger.warn(
        `Concurrency lease for call ${lease.callId} could not be renewed and will expire.`,
      );
    }
    return report;
  }

  /**
   * Replays durable leases into Redis. Bounded and pipelined because this runs
   * on the boot path: an unbounded scan would load every live lease into memory
   * and a per-lease round trip would delay module initialization in proportion
   * to the lease count. Anything beyond the bound is repaired by the
   * reconciliation worker on its next pass.
   */
  async recoverFromPostgres(limit = LEASE_RECOVERY_BATCH_SIZE): Promise<LeaseRecoveryReport> {
    const leases = await this.prisma.callConcurrencyLease.findMany({
      where: { state: 'active', expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    const report: LeaseRecoveryReport = { checked: leases.length, recovered: 0, failed: 0 };
    if (leases.length === 0) return report;

    try {
      const transaction = this.queue.getConnection().multi();
      for (const lease of leases) {
        const member = `${lease.callId}|${lease.leaseToken}`;
        transaction.zadd(this.globalKey(), lease.expiresAt.getTime(), member);
        transaction.zadd(this.organizationKey(lease.organizationId), lease.expiresAt.getTime(), member);
      }
      const results = (await transaction.exec()) ?? [];
      // Two writes per lease; a lease counts as recovered only when both of its
      // commands succeeded, so a partial pipeline is reported as a failure and
      // retried by the worker rather than silently assumed present.
      for (let index = 0; index < leases.length; index += 1) {
        const globalResult = results[index * 2];
        const orgResult = results[index * 2 + 1];
        const failed = !globalResult || globalResult[0] || !orgResult || orgResult[0];
        if (failed) report.failed += 1;
        else report.recovered += 1;
      }
    } catch (err) {
      this.logger.error(`Concurrency lease recovery pipeline failed: ${(err as Error).message}`);
      report.failed = leases.length;
    }
    return report;
  }

  /**
   * Resolves a Redis member that already exists for this call. The lease is
   * only handed back when the durable record agrees; any disagreement is real
   * divergence and fails closed rather than guessing which store is right.
   */
  private async adoptExistingLease(
    input: AcquireCallLeaseInput,
    leaseToken: string,
    expiresAt: Date,
  ): Promise<CallLeaseDecision> {
    try {
      const existing = await this.prisma.callConcurrencyLease.findUnique({
        where: { callId: input.callId },
        select: { organizationId: true, leaseToken: true, state: true },
      });

      if (!existing) {
        // The process died between ZADD and the durable write. Redis is
        // counting a slot nothing owns, so the record is recreated to make the
        // lease releasable and recoverable.
        await this.prisma.callConcurrencyLease.create({
          data: {
            callId: input.callId,
            organizationId: input.organizationId,
            leaseToken,
            state: 'active',
            expiresAt,
          },
        });
        return { allowed: true, leaseToken, expiresAt: expiresAt.toISOString() };
      }

      if (
        existing.organizationId !== input.organizationId ||
        existing.leaseToken !== leaseToken ||
        existing.state !== 'active'
      ) {
        this.logger.error(
          `Concurrency lease for call ${input.callId} diverged between Redis and PostgreSQL. Refusing admission.`,
        );
        return { allowed: false, reason: 'billing_temporarily_unavailable' };
      }

      return { allowed: true, leaseToken, expiresAt: expiresAt.toISOString() };
    } catch {
      // The Redis member may belong to a live call, so it is deliberately not
      // released on this path.
      return { allowed: false, reason: 'billing_temporarily_unavailable' };
    }
  }

  private async releaseRedis(callId: string, organizationId: string, leaseToken: string): Promise<void> {
    await this.queue.getConnection().eval(
      RELEASE_SCRIPT,
      2,
      this.globalKey(),
      this.organizationKey(organizationId),
      callId,
      leaseToken,
    );
  }

  private globalKey(): string {
    return 'vf:v1:billing:concurrency:global';
  }

  private organizationKey(organizationId: string): string {
    return `vf:v1:billing:concurrency:org:${organizationId}`;
  }
}
