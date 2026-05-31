import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type {
  CreateCheckoutSessionDto,
  CreatePortalSessionDto,
} from '@voiceforge/shared';
import {
  CreateCheckoutSessionDtoSchema,
  CreatePortalSessionDtoSchema,
} from '@voiceforge/shared';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService, ForbiddenPlanError } from './billing.service';

@Controller('workspaces/:workspaceId/billing')
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
  async getSubscription(@Param('workspaceId') workspaceId: string): Promise<unknown> {
    const orgId = await this.getOrgId(workspaceId);
    return this.billing.getSubscription(orgId);
  }

  @Get('status')
  getBillingStatus(): unknown {
    return this.billing.getBillingStatus();
  }

  @Get('usage')
  async getUsage(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const { period_start, period_end } = req.query as Record<string, string>;
    return this.billing.getWorkspaceUsage(
      workspaceId,
      period_start ? new Date(period_start) : undefined,
      period_end ? new Date(period_end) : undefined,
    );
  }

  @Post('checkout')
  async createCheckout(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateCheckoutSessionDtoSchema)) dto: CreateCheckoutSessionDto,
  ): Promise<{ url: string }> {
    const orgId = await this.getOrgId(workspaceId);
    try {
      return await this.billing.createCheckoutSession(orgId, dto);
    } catch (err) {
      if (err instanceof ForbiddenPlanError) throw err;
      throw err;
    }
  }

  @Post('portal')
  async createPortal(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreatePortalSessionDtoSchema)) dto: CreatePortalSessionDto,
  ): Promise<{ url: string }> {
    const orgId = await this.getOrgId(workspaceId);
    return this.billing.createPortalSession(orgId, dto);
  }

  @Get('invoices')
  async getInvoices(@Param('workspaceId') workspaceId: string): Promise<{ items: unknown[] }> {
    const orgId = await this.getOrgId(workspaceId);
    const sub = await this.billing.getSubscription(orgId);
    if (!sub?.stripeCustomerId) return { items: [] };
    return this.billing.getInvoices(sub.stripeCustomerId);
  }
}
