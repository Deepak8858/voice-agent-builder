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
    // DB check
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }

    // Redis / Valkey check
    const redis = await this.queue.ping();

    // LLM provider always resolves to a real adapter (mock providers removed).
    return {
      status: db === 'ok' && redis !== 'error' ? 'ok' : 'degraded',
      db,
      redis,
      llm: { provider: this.llm.name, status: 'ok' },
      time: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
