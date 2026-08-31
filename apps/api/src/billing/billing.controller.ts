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
  SessionUser,
  BillingSummaryDto,
  CreateCheckoutSessionDto,
  CreatePortalSessionDto,
  CreateTopUpCheckoutDto,
} from '@voiceforge/shared';
import {
  CreateCheckoutSessionDtoSchema,
  CreatePortalSessionDtoSchema,
  CreateTopUpCheckoutDtoSchema,
} from '@voiceforge/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
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

  /**
   * The single place a workspace the caller has access to becomes the
   * organization whose money is at stake, so it is the one place the
   * organization/workspace scope mismatch can be closed.
   *
   * A white-label client workspace is created with its parent agency's
   * `organizationId` (`white-label.service.ts:179`) and its creator's chosen
   * user as `owner`. Without this predicate that client owner reached the
   * AGENCY's subscription, invoices, checkout and billing portal — and the
   * portal alone lets them change or cancel the agency's plan for every other
   * client on it. Only a billing root may speak for the organization: no
   * parent, and not marked as someone else's client.
   */
  private async getOrgId(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true, parentWorkspaceId: true, type: true },
    });
    if (!ws) throw new BadRequestException('Workspace not found');
    // Both conditions are checked, not just the one that implies the other:
    // they are written together today, and a future path that sets only one
    // must not silently reopen this.
    if (ws.parentWorkspaceId !== null || ws.type === 'client') {
      throw new ForbiddenError(
        'Billing is managed on the parent workspace, not on a client workspace.',
      );
    }
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

  /**
   * Billing is owned by the organization, so this returns organization totals
   * even though it is reached through a workspace the caller has access to.
   */
  @Get('summary')
  async getSummary(@Param('workspaceId') workspaceId: string): Promise<BillingSummaryDto> {
    const orgId = await this.getOrgId(workspaceId);
    return this.billing.getBillingSummary(orgId);
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

  // Money routes are owner+admin; RoleGuard re-resolves the seat rather than
  // trusting the session copy the old assertBillingAdmin read.
  @Post('checkout')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  async createCheckout(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateCheckoutSessionDtoSchema)) dto: CreateCheckoutSessionDto,
    @CurrentUser() user: SessionUser,
  ): Promise<{ url: string }> {
    const orgId = await this.getOrgId(workspaceId);
    try {
      return await this.billing.createCheckoutSession(orgId, dto, user.id);
    } catch (err) {
      if (err instanceof ForbiddenPlanError) throw err;
      throw err;
    }
  }

  /**
   * The pack price is server-owned; the request body carries only the return
   * paths so a client can never name a price or an amount.
   */
  @Post('topup-checkout')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  async createTopUpCheckout(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateTopUpCheckoutDtoSchema)) dto: CreateTopUpCheckoutDto,
    @CurrentUser() user: SessionUser,
  ): Promise<{ url: string }> {
    const orgId = await this.getOrgId(workspaceId);
    return this.billing.createTopUpCheckoutSession(orgId, dto, user.id);
  }

  @Post('portal')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  async createPortal(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreatePortalSessionDtoSchema)) dto: CreatePortalSessionDto,
    @CurrentUser() user: SessionUser,
  ): Promise<{ url: string }> {
    const orgId = await this.getOrgId(workspaceId);
    return this.billing.createPortalSession(orgId, dto, user.id);
  }

  // The one admin-gated read: invoices carry the organization's billing
  // address and payment history, which members below admin have no seat to see.
  @Get('invoices')
  @UseGuards(RoleGuard)
  @RequiredRole('owner', 'admin')
  async getInvoices(
    @Param('workspaceId') workspaceId: string,
  ): Promise<{ items: unknown[] }> {
    const orgId = await this.getOrgId(workspaceId);
    const sub = await this.billing.getSubscription(orgId);
    if (!sub?.dodoCustomerId) return { items: [] };
    return this.billing.getInvoices(sub.dodoCustomerId);
  }
}
