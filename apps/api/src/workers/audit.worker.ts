import { type Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../audit/audit.service';

export const AUDIT_QUEUE = 'audit';

@Injectable()
export class AuditWorker extends BaseWorker<{
  workspaceId: string;
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}> {
  constructor(
    queueService: QueueService,
    private readonly audit: AuditService,
  ) {
    super(AUDIT_QUEUE, queueService, 20);
  }

  async processor(
    job: Job<{
      workspaceId: string;
      actorUserId?: string;
      action: string;
      resourceType: string;
      resourceId: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    await this.audit.log({
      workspaceId: job.data.workspaceId,
      actorUserId: job.data.actorUserId ?? 'system',
      action: job.data.action,
      resourceType: job.data.resourceType,
      resourceId: job.data.resourceId,
      metadata: job.data.metadata,
    });
  }
}
