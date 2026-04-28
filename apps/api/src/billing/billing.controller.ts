import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type {
  CreateCheckoutSessionDto,
  CreatePortalSessionDto,
  SessionUser,
} from '@voiceforge/shared';
import { WorkspaceGuard } from '../common/workspace.guard';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService, ForbiddenPlanError } from './billing.service';

@Controller(':workspaceId/billing')
@UseGuards(WorkspaceGuard)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  private async getOrgId(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!ws) throw new BadRequestException('Workspace not found');
    return ws.organizationId;
  }

  @Get('subscription')
  async getSubscription(@Req() req: Request): Promise<unknown> {
    const orgId = await this.getOrgId(req.params['workspaceId']);
    return this.billing.getSubscription(orgId);
  }

  @Get('usage')
  async getUsage(@Req() req: Request): Promise<unknown> {
    const user = (req as Request & { user: SessionUser }).user;
    const { period_start, period_end } = req.query as Record<string, string>;
    return this.billing.getWorkspaceUsage(
      user.active_workspace_id,
      period_start ? new Date(period_start) : undefined,
      period_end ? new Date(period_end) : undefined,
    );
  }

  @Post('checkout')
  async createCheckout(@Req() req: Request): Promise<{ url: string }> {
    const orgId = await this.getOrgId(req.params['workspaceId']);
    const dto = req.body as CreateCheckoutSessionDto;
    if (!dto.priceId || !dto.successUrl || !dto.cancelUrl) {
      throw new BadRequestException('priceId, successUrl, cancelUrl are required');
    }
    try {
      return await this.billing.createCheckoutSession(orgId, dto);
    } catch (err) {
      if (err instanceof ForbiddenPlanError) throw err;
      throw err;
    }
  }

  @Post('portal')
  async createPortal(@Req() req: Request): Promise<{ url: string }> {
    const orgId = await this.getOrgId(req.params['workspaceId']);
    const dto = (req.body ?? {}) as CreatePortalSessionDto;
    return this.billing.createPortalSession(orgId, dto);
  }
}