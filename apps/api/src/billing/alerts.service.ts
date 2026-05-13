import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { PLAN_LIMITS } from '@voiceforge/shared';

interface OverageCheckResult {
  atLimit: boolean;
  warningThreshold: boolean;
  percentage: number;
  calls: { used: number; limit: number };
  minutes: { used: number; limit: number };
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async checkOverageAlert(orgId: string): Promise<OverageCheckResult> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const sub = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    const plan = (sub?.plan ?? 'free') as keyof typeof PLAN_LIMITS;
    const limits = PLAN_LIMITS[plan];

    const records = await this.prisma.usageRecord.groupBy({
      by: ['billableMetric'],
      where: { organizationId: orgId, periodStart: { gte: startOfMonth } },
      _sum: { quantity: true },
    });

    const usedCalls = Number(records.find(r => r.billableMetric === 'calls')?._sum.quantity ?? 0);
    const usedMinutes = Number(records.find(r => r.billableMetric === 'minutes')?._sum.quantity ?? 0);
    const limitCalls = limits.outboundCalls <= 0 ? Infinity : limits.outboundCalls;
    const limitMinutes = limits.minutes <= 0 ? Infinity : limits.minutes;

    const callsPct = limitCalls === Infinity ? 0 : usedCalls / limitCalls;
    const minutesPct = limitMinutes === Infinity ? 0 : usedMinutes / limitMinutes;
    const maxPct = Math.max(callsPct, minutesPct);

    return {
      atLimit: maxPct >= 1,
      warningThreshold: maxPct >= 0.8 && maxPct < 1,
      percentage: Number.isFinite(maxPct) ? Math.round(maxPct * 100) : 0,
      calls: { used: usedCalls, limit: limitCalls === Infinity ? -1 : limitCalls },
      minutes: { used: usedMinutes, limit: limitMinutes === Infinity ? -1 : limitMinutes },
    };
  }

  async sendOverageAlerts(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({
      where: { status: 'active' },
      include: { owner: { select: { email: true } } },
    });

    for (const org of orgs) {
      const check = await this.checkOverageAlert(org.id);
      if (!check.atLimit && !check.warningThreshold) continue;

      const type = check.atLimit ? 'at_limit' : 'warning';
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const existing = await this.prisma.alert.findFirst({
        where: { organizationId: org.id, type, sentAt: { gte: thirtyDaysAgo } },
      });
      if (existing) continue;

      if (org.owner?.email) {
        const result = await this.email.sendOverageAlert({
          to: org.owner.email,
          orgName: org.name,
          type,
          percentage: check.percentage,
          calls: check.calls,
          minutes: check.minutes,
        }).catch(err => {
          this.logger.error('Failed to send alert email', err);
          return { delivered: false };
        });
        if (!result.delivered) continue;
      }

      await this.prisma.alert.create({
        data: { organizationId: org.id, type, percentage: check.percentage },
      });
    }
  }
}