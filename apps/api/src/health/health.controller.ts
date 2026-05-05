import { Controller, Get, Inject } from '@nestjs/common';
import { LLM_PROVIDER_TOKEN, type LlmAgentGenerator } from '../llm/llm.provider.interface';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmAgentGenerator,
  ) {}

  @Get()
  async check() {
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }

    const redis = await this.queue.ping();

    let llm: 'ok' | 'unavailable' = 'unavailable';
    if (this.llm.healthCheck) {
      llm = await this.llm.healthCheck();
    }

    const allHealthy = db === 'ok' && redis === 'ok' && llm === 'ok';
    const anyUp = db === 'ok' || redis === 'ok';

    return {
      status: allHealthy ? 'healthy' : anyUp ? 'degraded' : 'unhealthy',
      checks: {
        db,
        redis,
        llm: { provider: this.llm.name, status: llm },
      },
      time: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
