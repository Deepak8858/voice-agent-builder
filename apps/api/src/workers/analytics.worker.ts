import { type Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { AnalyticsService } from '../analytics/analytics.service';

export const ANALYTICS_QUEUE = 'analytics';

@Injectable()
export class AnalyticsWorker extends BaseWorker<{
  workspaceId: string;
  agentId?: string;
  callId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}> {
  constructor(
    queueService: QueueService,
    private readonly analytics: AnalyticsService,
  ) {
    super(ANALYTICS_QUEUE, queueService, 10);
  }

  async processor(
    job: Job<{
      workspaceId: string;
      agentId?: string;
      callId?: string;
      eventType: string;
      payload: Record<string, unknown>;
    }>,
  ): Promise<void> {
    await this.analytics.recordEventInternal({
      workspaceId: job.data.workspaceId,
      agentId: job.data.agentId,
      callId: job.data.callId,
      eventType: job.data.eventType,
      payload: job.data.payload,
    });
  }
}
