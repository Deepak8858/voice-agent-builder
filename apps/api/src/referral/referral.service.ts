import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';

export const REFERRAL_BONUS_MINUTES = 100;
export const REFERRAL_BONUS_PAID_MINUTES = 500;
export const REFERRAL_EXPIRY_DAYS = 30;

@Injectable()
export class ReferralService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a referral with an invite token and credits the referrer
   * with bonus minutes. The invite token is returned for sharing.
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

    // Record bonus minutes for referrer
    await this.recordBonusMinutes(args.referrerWorkspaceId, workspace.organizationId, REFERRAL_BONUS_MINUTES);

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
   * Accepts a referral invitation, links the referred user, and credits
   * bonus minutes to the new user's workspace.
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

    await this.prisma.$transaction([
      this.prisma.referral.update({
        where: { id: referral.id },
        data: {
          referredUserId: args.referredUserId,
          referredWorkspaceId: args.referredWorkspaceId,
          referredOrganizationId: referredWorkspace.organizationId,
          status: 'converted',
          bonusAwardedAt: new Date(),
        },
      }),
      this.createBonusUsageRecord(args.referredWorkspaceId, referredWorkspace.organizationId, REFERRAL_BONUS_MINUTES),
    ]);

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
   * Awards bonus minutes to referrer when the referred user converts to paid.
   */
  async awardPaidConversionBonus(args: {
    referralId: string;
  }): Promise<void> {
    const referral = await this.prisma.referral.findUnique({
      where: { id: args.referralId },
    });

    if (!referral) return;
    if (referral.status === 'bonus_awarded') return;

    await this.recordBonusMinutes(
      referral.referrerWorkspaceId,
      referral.referrerOrganizationId,
      REFERRAL_BONUS_PAID_MINUTES,
    );

    await this.prisma.referral.update({
      where: { id: referral.id },
      data: { status: 'bonus_awarded' },
    });

    await this.audit.log({
      workspaceId: referral.referrerWorkspaceId,
      actorUserId: referral.referrerUserId,
      action: 'referral.bonus_paid',
      resourceType: 'referral',
      resourceId: referral.id,
      metadata: { bonusMinutes: REFERRAL_BONUS_PAID_MINUTES },
    });
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

  private createBonusUsageRecord(
    workspaceId: string,
    organizationId: string,
    minutes: number,
  ) {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    return this.prisma.usageRecord.create({
      data: {
        workspaceId,
        organizationId,
        billableMetric: 'minutes',
        quantity: minutes,
        periodStart,
        periodEnd,
      },
    });
  }

  private async recordBonusMinutes(
    workspaceId: string,
    organizationId: string,
    minutes: number,
  ): Promise<void> {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await this.prisma.usageRecord.create({
      data: {
        workspaceId,
        organizationId,
        billableMetric: 'minutes',
        quantity: minutes,
        periodStart,
        periodEnd,
      },
    });
  }

  private generateToken(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let token = '';
    for (let i = 0; i < 24; i++) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
  }
}
