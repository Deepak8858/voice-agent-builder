import { type Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import { EvaluationsService } from '../evaluations/evaluations.service';

export const EVALUATION_QUEUE = 'evaluation';

@Injectable()
export class EvaluationWorker extends BaseWorker<{ callId: string; workspaceId: string }> {
  constructor(
    queueService: QueueService,
    private readonly evaluations: EvaluationsService,
  ) {
    super(EVALUATION_QUEUE, queueService, 3);
  }

  async processor(job: Job<{ callId: string; workspaceId: string }>): Promise<void> {
    await this.evaluations.evaluateCall(job.data.callId);
  }
}
