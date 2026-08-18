import { type Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { BaseWorker } from './base.worker';
import { QueueService } from '../queue/queue.service';
import {
  AGENT_GEN_QUEUE,
  AgentGenService,
  type AgentGenJobPayload,
} from '../agent-gen/agent-gen.service';
import { env } from '../config/env';

/**
 * Processes chat-to-agent generation jobs. Each job runs one LLM turn for a
 * session. Non-final failures are re-thrown so BullMQ retries with backoff;
 * the final attempt marks the session failed so the client sees the error
 * instead of polling forever.
 */
@Injectable()
export class AgentGenWorker extends BaseWorker<AgentGenJobPayload> {
  constructor(
    queueService: QueueService,
    private readonly sessions: AgentGenService,
  ) {
    super(AGENT_GEN_QUEUE, queueService, env.AGENT_GEN_WORKER_CONCURRENCY);
  }

  async processor(job: Job<AgentGenJobPayload>): Promise<void> {
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await this.sessions.processGeneration(job.data, isFinalAttempt);
  }
}
