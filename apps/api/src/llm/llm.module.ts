import { Global, Logger, Module } from '@nestjs/common';
import { LocalTemplateAgentGenerator } from '../agents/local-template-generator.service';
import { env } from '../config/env';
import { AzureAiFoundryAdapter } from './adapters/azure-aifoundry.adapter';
import { GithubModelsLlmAdapter } from './adapters/github-models.adapter';
import { OpenAiLlmAdapter } from './adapters/openai.adapter';
import { LlmCacheService } from './llm-cache.service';
import { LLM_PROVIDER_TOKEN, type LlmAgentGenerator } from './llm.provider.interface';

function resolveLlmProvider(
  local: LocalTemplateAgentGenerator,
  github: GithubModelsLlmAdapter,
  openai: OpenAiLlmAdapter,
  azure: AzureAiFoundryAdapter,
): LlmAgentGenerator {
  const logger = new Logger('LlmModule');
  switch (env.LLM_PROVIDER) {
    case 'github':
      if (!env.GITHUB_TOKEN) {
        throw new Error('LLM_PROVIDER=github but GITHUB_TOKEN is not set.');
      }
      return github;
    case 'openai':
      if (!env.OPENAI_API_KEY) {
        throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is not set.');
      }
      return openai;
    case 'azure-aifoundry':
      if (!env.LLM_API_KEY) {
        throw new Error('LLM_PROVIDER=azure-aifoundry but LLM_API_KEY is not set.');
      }
      return azure;
    case 'local':
    default:
      logger.log('Using local template-based agent generator (no external LLM API key required).');
      return local;
  }
}

@Global()
@Module({
  providers: [
    LocalTemplateAgentGenerator,
    LlmCacheService,
    GithubModelsLlmAdapter,
    OpenAiLlmAdapter,
    AzureAiFoundryAdapter,
    {
      provide: LLM_PROVIDER_TOKEN,
      inject: [LocalTemplateAgentGenerator, GithubModelsLlmAdapter, OpenAiLlmAdapter, AzureAiFoundryAdapter],
      useFactory: resolveLlmProvider,
    },
  ],
  exports: [LLM_PROVIDER_TOKEN, LocalTemplateAgentGenerator, LlmCacheService],
})
export class LlmModule {}
