import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from './usage.service';

@Controller('v1/orgs')
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id/usage')
  async getCurrentMonthUsage(@Param('id') orgId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');
    return this.usage.getCurrentMonthUsage(orgId);
  }

  @Get(':id/usage/trends')
  async getHistoricalUsage(
    @Param('id') orgId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');

    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevPeriod = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

    const months = await this.usage.getHistoricalUsage(orgId, from, to);

    const currentMonth = months.find((m) => m.period === currentPeriod);
    const prevMonth = months.find((m) => m.period === prevPeriod);

    let mom_delta: number | null = null;
    if (currentMonth && prevMonth && prevMonth.estimated_cost > 0) {
      mom_delta = Math.round(
        ((currentMonth.estimated_cost - prevMonth.estimated_cost) / prevMonth.estimated_cost) * 100,
      ) / 100;
    }

    return { months, mom_delta };
  }
}