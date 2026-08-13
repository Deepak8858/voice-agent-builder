import { Injectable } from '@nestjs/common';
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
export type CallLeaseDecision =
  | { allowed: true; leaseToken: string; expiresAt: string }
  | { allowed: false; reason: 'organization_concurrency_reached' | 'platform_concurrency_reached' | 'billing_temporarily_unavailable' };
export type LeaseRecoveryReport = { checked: number; recovered: number; failed: number };

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
export class CallConcurrencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

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
      } catch {
        await this.releaseRedis(input.callId, input.organizationId, resolvedToken).catch(() => undefined);
        return { allowed: false, reason: 'billing_temporarily_unavailable' };
      }
      return { allowed: true, leaseToken: resolvedToken, expiresAt: expiresAt.toISOString() };
    } catch {
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
    } catch {
      return false;
    }
  }

  async release(rawInput: ReleaseCallLeaseInput): Promise<void> {
    const input = TokenInputSchema.parse(rawInput);
    await this.releaseRedis(input.callId, input.organizationId, input.leaseToken);
    await this.prisma.callConcurrencyLease.updateMany({
      where: { callId: input.callId, organizationId: input.organizationId, leaseToken: input.leaseToken, state: 'active' },
      data: { state: 'released', expiresAt: new Date() },
    });
  }

  async recoverFromPostgres(): Promise<LeaseRecoveryReport> {
    const leases = await this.prisma.callConcurrencyLease.findMany({
      where: { state: 'active', expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'asc' },
    });
    const report: LeaseRecoveryReport = { checked: leases.length, recovered: 0, failed: 0 };
    for (const lease of leases) {
      try {
        const connection = this.queue.getConnection();
        const member = `${lease.callId}|${lease.leaseToken}`;
        const transaction = connection.multi();
        transaction.zadd(this.globalKey(), lease.expiresAt.getTime(), member);
        transaction.zadd(this.organizationKey(lease.organizationId), lease.expiresAt.getTime(), member);
        await transaction.exec();
        report.recovered += 1;
      } catch {
        report.failed += 1;
      }
    }
    return report;
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
