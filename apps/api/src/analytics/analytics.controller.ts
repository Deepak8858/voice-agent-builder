import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  MetricsRangeQuerySchema,
  RecordAnalyticsEventDtoSchema,
  type FeatureGate,
  type MetricsRangeQuery,
  type RecordAnalyticsEventDto,
} from '@voiceforge/shared';
import { BillingService, ForbiddenPlanError } from '../billing/billing.service';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

const BILLING_UPGRADE_PATH = '/dashboard/billing';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Plan gate for the reporting side of this controller.
   *
   * `checkFeatureGate` has answered `analytics` and `ai_insights` since it was
   * written - both are `plan !== 'free' && paidAccess` - but nothing ever asked
   * it, so every Free workspace read the full dashboard. The gate lives here
   * rather than in AnalyticsService because the service is hand-constructed in
   * 47 test sites with prisma alone; an optional `billing` arg there would be a
   * fail-open shape in exchange for nothing, since the controller is the only
   * caller of all six methods.
   *
   * Ahead of the service call, so a cached window cannot answer a request the
   * plan does not entitle.
   */
  private async assertPlanAllows(workspaceId: string, gate: FeatureGate, message: string) {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!(await this.billing.checkFeatureGate(workspace.organizationId, gate))) {
      throw new ForbiddenPlanError(message, {
        limitType: gate,
        currentPlan: 'free',
        upgradePath: BILLING_UPGRADE_PATH,
      });
    }
  }

  /** Refusal copy is shared so all five reporting routes read identically. */
  private assertAnalyticsAllowed(workspaceId: string) {
    return this.assertPlanAllows(
      workspaceId,
      'analytics',
      'Analytics reporting requires a paid plan.',
    );
  }

  // Ingestion is deliberately NOT gated: it is instrumentation the product
  // writes on every plan, and a Free workspace that stops recording events has
  // nothing to show the day it upgrades.
  @Post('events')
  @HttpCode(201)
  async record(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(RecordAnalyticsEventDtoSchema))
    dto: RecordAnalyticsEventDto,
  ) {
    return this.analytics.recordEvent(workspaceId, dto);
  }

  @Get('events')
  async events(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    await this.assertAnalyticsAllowed(workspaceId);
    return { items: await this.analytics.listEvents(workspaceId, query) };
  }

  @Get('workspace')
  async workspace(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    await this.assertAnalyticsAllowed(workspaceId);
    return this.analytics.workspaceMetrics(workspaceId, query);
  }

  @Get('agents')
  async agents(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    await this.assertAnalyticsAllowed(workspaceId);
    return this.analytics.agentMetrics(workspaceId, query);
  }

  @Get('compliance')
  async compliance(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    await this.assertAnalyticsAllowed(workspaceId);
    return this.analytics.complianceMetrics(workspaceId, query);
  }

  @Get('agents/:agentId/suggestions')
  async suggestions(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    // `ai_insights`, not `analytics`: this route sells agent-improvement advice,
    // and the refusal's `limitType` is what the upgrade prompt names.
    await this.assertPlanAllows(
      workspaceId,
      'ai_insights',
      'AI improvement suggestions require a paid plan.',
    );
    return this.analytics.improvementSuggestions(workspaceId, agentId, query);
  }

  @Get('timeseries')
  async timeseries(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    await this.assertAnalyticsAllowed(workspaceId);
    return this.analytics.timeseriesMetrics(workspaceId, query);
  }
}
