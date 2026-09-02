import { Injectable } from '@nestjs/common';
import { type Job } from 'bullmq';
import { z } from 'zod';
import { AGENT_SHEET_QUEUE } from '../agent-sheets/agent-sheet.queue';
import { AgentSheetService, type SheetSyncJob } from '../agent-sheets/agent-sheet.service';
import { QueueService } from '../queue/queue.service';
import { BaseWorker } from './base.worker';

const SheetSyncJobSchema = z.object({
  callId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

/**
 * Writes a call's row to its agent's Google Sheet. Concurrency 1 on purpose:
 * the first job for a call appends the row and records its number, later
 * jobs update it, and two jobs for the same call running at once would append
 * twice.
 */
@Injectable()
export class AgentSheetSyncWorker extends BaseWorker<{ callId: string; workspaceId: string }> {
  constructor(
    queue: QueueService,
    private readonly sheets: AgentSheetService,
  ) {
    super(AGENT_SHEET_QUEUE, queue, 1);
  }

  async processor(job: Job<{ callId: string; workspaceId: string }>): Promise<void> {
    const parsed = SheetSyncJobSchema.safeParse(job.data);
    if (!parsed.success) {
      this.logger.warn(`Dropping malformed sheet sync job ${job.id}: ${parsed.error.message}`);
      return;
    }
    // `tsconfig.build.json` compiles with strict off, which turns the inferred
    // zod type into all-optional fields; the parse above has already proven both.
    await this.sheets.syncCallRow(parsed.data as SheetSyncJob);
  }
}
