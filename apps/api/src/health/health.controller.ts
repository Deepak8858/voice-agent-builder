import { Controller, Get, Inject } from '@nestjs/common';
import { LLM_PROVIDER_TOKEN, type LlmAgentGenerator } from '../llm/llm.provider.interface';
import { QueueService } from '../queue/queue.service';
import { Public } from '../common/decorators/public.decorator';
import { DatabaseHealthService } from './database-health.service';
import { env } from '../config/env';

const DB_HEALTH_TIMEOUT_MS = 750;
const DEPENDENCY_HEALTH_TIMEOUT_MS = 750;

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly databaseHealth: DatabaseHealthService,
    private readonly queue: QueueService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmAgentGenerator,
  ) {}

  @Get()
  async check() {
    const [db, redis, llm] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkLlm(),
    ]);

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

  private async checkDb(): Promise<'ok' | 'error'> {
    try {
      return await withTimeout(this.databaseHealth.check(), DB_HEALTH_TIMEOUT_MS);
    } catch {
      return 'error';
    }
  }

  private async checkRedis(): Promise<'ok' | 'error'> {
    try {
      return await withTimeout(this.queue.ping(), DEPENDENCY_HEALTH_TIMEOUT_MS);
    } catch {
      return 'error';
    }
  }

  private async checkLlm(): Promise<'ok' | 'unavailable'> {
    return llmProviderConfigured(this.llm.name) ? 'ok' : 'unavailable';
  }
}

function llmProviderConfigured(provider: string): boolean {
  switch (provider) {
    case 'openai':
      return Boolean(env.OPENAI_API_KEY);
    case 'github':
      return Boolean(env.GITHUB_TOKEN);
    case 'anthropic':
      return Boolean(env.ANTHROPIC_API_KEY);
    case 'azure-aifoundry':
      return Boolean(env.LLM_API_KEY);
    default:
      return false;
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation.finally(() => clearTimeout(timeout)),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('health check timeout')), timeoutMs);
    }),
  ]);
}
