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
  type MetricsRangeQuery,
  type RecordAnalyticsEventDto,
} from '@voiceforge/shared';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AnalyticsService } from './analytics.service';

@UseGuards(WorkspaceGuard)
@Controller('workspaces/:workspaceId/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

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
    return { items: await this.analytics.listEvents(workspaceId, query) };
  }

  @Get('workspace')
  async workspace(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    return this.analytics.workspaceMetrics(workspaceId, query);
  }

  @Get('agents')
  async agents(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    return this.analytics.agentMetrics(workspaceId, query);
  }

  @Get('compliance')
  async compliance(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    return this.analytics.complianceMetrics(workspaceId, query);
  }

  @Get('agents/:agentId/suggestions')
  async suggestions(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Query(new ZodValidationPipe(MetricsRangeQuerySchema)) query: MetricsRangeQuery,
  ) {
    return this.analytics.improvementSuggestions(workspaceId, agentId, query);
  }
}
