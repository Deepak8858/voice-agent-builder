import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';

/**
 * The bonus a converted referral *promises*, recorded on the referral row so
 * the commitment is auditable. Nothing in this module grants it: credit lives
 * in `CreditLedgerService`, and no referral grant path exists there yet (see
 * the note on {@link ReferralService}). Treat this as the tracked promise, not
 * as a balance.
 */
export const REFERRAL_BONUS_MINUTES = 100;
export const REFERRAL_EXPIRY_DAYS = 30;

/**
 * Referral *tracking*. This service issues invite tokens and records
 * conversions; it does not move money.
 *
 * It used to claim it credited minutes, and what it actually wrote was a
 * `UsageRecord` with `billableMetric: 'minutes'` — the same row `calls.service`
 * writes when a call *consumes* minutes, and one of the rows
 * `BillingService.getWorkspaceUsage` sums into the usage figure shown against
 * the plan limit. So every invite created charged its author 100 minutes of
 * reported usage and every acceptance charged the invitee another 100: the
 * exact inverse of the promise, on both sides. Those writes are gone.
 *
 * Granting the bonus for real means one new grant path in
 * `CreditLedgerService` (the only mint in the system) and a decision on the
 * amount, the credit's source type/priority, and its expiry — none of which
 * exist in the billing catalog. Until they do, this module records the promise
 * and says so, rather than corrupting usage while appearing to honour it.
 */
@Injectable()
export class ReferralService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a referral with an invite token, returned for sharing.
   *
   * No credit is granted here even once one exists: an invite is not a
   * conversion, and crediting on creation would let one user mint an unbounded
   * bonus by calling this in a loop.
   */
  async createReferral(args: {
    actorUserId: string;
    referrerWorkspaceId: string;
  }): Promise<{ inviteToken: string }> {
    // Get the organization from the workspace
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: args.referrerWorkspaceId },
      select: { organizationId: true },
    });
    if (!workspace) throw new AppError('UNAUTHORIZED', 'Referrer workspace not found', 401);

    const inviteToken = this.generateToken();

    await this.prisma.referral.create({
      data: {
        referrerUserId: args.actorUserId,
        referrerWorkspaceId: args.referrerWorkspaceId,
        referrerOrganizationId: workspace.organizationId,
        inviteToken,
        status: 'pending',
        bonusMinutes: REFERRAL_BONUS_MINUTES,
      },
    });

    await this.audit.log({
      workspaceId: args.referrerWorkspaceId,
      actorUserId: args.actorUserId,
      action: 'referral.created',
      resourceType: 'referral',
      metadata: { bonusMinutes: REFERRAL_BONUS_MINUTES },
    });

    return { inviteToken };
  }

  /**
   * Accepts a referral invitation and links the referred user.
   *
   * No credit is granted; see the note on this class. What this does record is
   * the conversion a future grant would pay out on, so the eligibility checks
   * below are the ones that keep such a grant honest.
   */
  async acceptReferral(args: {
    inviteToken: string;
    referredUserId: string;
    referredWorkspaceId: string;
  }): Promise<{ status: string; bonusMinutes: number }> {
    const referral = await this.prisma.referral.findUnique({
      where: { inviteToken: args.inviteToken },
    });

    if (!referral) throw new AppError('NOT_FOUND', 'Invalid referral token', 404);
    if (referral.status !== 'pending') throw new AppError('INVALID_STATUS', `Referral already ${referral.status}`, 400);
    if (referral.referrerUserId === args.referredUserId) throw new AppError('VALIDATION_ERROR', 'Cannot refer yourself', 400);

    const createdAt = new Date(referral.createdAt);
    const expiryCheck = new Date(createdAt);
    expiryCheck.setDate(expiryCheck.getDate() + REFERRAL_EXPIRY_DAYS);
    if (expiryCheck < new Date()) throw new AppError('INVALID_STATUS', 'Referral has expired', 400);

    const referredWorkspace = await this.prisma.workspace.findUnique({
      where: { id: args.referredWorkspaceId },
      select: { organizationId: true },
    });
    if (!referredWorkspace) throw new AppError('UNAUTHORIZED', 'Referred workspace not found', 401);
    // The user-id check above only catches one person holding both ends. Two
    // seats in the same organization referring each other are two different
    // users, so without this an organization could convert its own invites — and
    // any bonus attached to a conversion would be paid to the tenant that spent
    // nothing. Referral means bringing in another tenant.
    if (referral.referrerOrganizationId === referredWorkspace.organizationId) {
      throw new AppError('VALIDATION_ERROR', 'Cannot refer your own organization', 400);
    }

    // Compare-and-set on `status`, not a bare update: two concurrent accepts of
    // one token both read `pending` above, and the loser must be told the
    // referral is already converted rather than silently rewriting who converted
    // it. This is also the single place a conversion is stamped, so it is the
    // hook a future credit grant hangs its per-referral idempotency off.
    const converted = await this.prisma.referral.updateMany({
      where: { id: referral.id, status: 'pending' },
      data: {
        referredUserId: args.referredUserId,
        referredWorkspaceId: args.referredWorkspaceId,
        referredOrganizationId: referredWorkspace.organizationId,
        status: 'converted',
        bonusAwardedAt: new Date(),
      },
    });
    if (converted.count === 0) {
      throw new AppError('INVALID_STATUS', 'Referral already converted', 400);
    }

    await this.audit.log({
      workspaceId: args.referredWorkspaceId,
      actorUserId: args.referredUserId,
      action: 'referral.accepted',
      resourceType: 'referral',
      resourceId: referral.id,
      metadata: {
        referrerUserId: referral.referrerUserId,
        referredUserId: args.referredUserId,
        bonusMinutes: REFERRAL_BONUS_MINUTES,
      },
    });

    return { status: 'converted', bonusMinutes: REFERRAL_BONUS_MINUTES };
  }

  /**
   * Lists all referrals for a workspace.
   */
  async listReferrals(workspaceId: string): Promise<
    Array<{
      id: string;
      status: string;
      bonusMinutes: number;
      inviteToken: string;
      createdAt: string;
    }>
  > {
    const rows = await this.prisma.referral.findMany({
      where: { referrerWorkspaceId: workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      bonusMinutes: r.bonusMinutes,
      inviteToken: r.inviteToken,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------

  /**
   * The token is the whole authorization for `acceptReferral`, so it is drawn
   * from `node:crypto` rather than `Math.random()`. V8's PRNG state is
   * recoverable from a handful of outputs, which made previously-issued tokens
   * guessable — and a guessed token lets a stranger consume someone else's
   * invite (and, once a bonus exists, claim it).
   */
  private generateToken(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let token = '';
    for (let i = 0; i < 24; i++) {
      token += chars[randomInt(chars.length)];
    }
    return token;
  }
}
