import { Worker, type Job } from 'bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';

/** Base class for all BullMQ workers. Handles lifecycle + graceful shutdown. */
export abstract class BaseWorker<T extends object = object> implements OnModuleDestroy {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly worker: Worker;

  constructor(
    queueName: string,
    private readonly queueService: QueueService,
    concurrency = 5,
  ) {
    const connection = queueService.getConnection();
    if (!connection) {
      this.logger.warn(`[${queueName}] Redis not configured — worker disabled`);
      this.worker = null as unknown as Worker;
      return;
    }
    this.worker = new Worker(queueName, this.processor.bind(this), {
      connection,
      concurrency,
    });
    this.worker.on('completed', (job) => this.logger.debug(`[${queueName}] job ${job.id} done`));
    this.worker.on('failed', (job, err) => this.logger.error(`[${queueName}] job ${job?.id} failed: ${err.message}`));
  }

  abstract processor(job: Job<T>): Promise<void>;

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}
