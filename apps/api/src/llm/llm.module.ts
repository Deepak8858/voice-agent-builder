import { Global, Logger, Module } from '@nestjs/common';
import { LocalTemplateAgentGenerator } from '../agents/local-template-generator.service';
import { env } from '../config/env';
import { AnthropicLlmAdapter } from './adapters/anthropic.adapter';
import { AzureAiFoundryAdapter } from './adapters/azure-aifoundry.adapter';
import { GithubModelsLlmAdapter } from './adapters/github-models.adapter';
import { OpenAiLlmAdapter } from './adapters/openai.adapter';
import { LlmCacheService } from './llm-cache.service';
import { LLM_PROVIDER_TOKEN, type LlmAgentGenerator } from './llm.provider.interface';

@Global()
@Module({
  providers: [
    LocalTemplateAgentGenerator,
    LlmCacheService,
    GithubModelsLlmAdapter,
    OpenAiLlmAdapter,
    AnthropicLlmAdapter,
    AzureAiFoundryAdapter,
    {
      provide: LLM_PROVIDER_TOKEN,
      inject: [LocalTemplateAgentGenerator, GithubModelsLlmAdapter, OpenAiLlmAdapter, AnthropicLlmAdapter, AzureAiFoundryAdapter],
      useFactory: (
        local: LocalTemplateAgentGenerator,
        github: GithubModelsLlmAdapter,
        openai: OpenAiLlmAdapter,
        anthropic: AnthropicLlmAdapter,
        azure: AzureAiFoundryAdapter,
      ): LlmAgentGenerator => {
        const logger = new Logger('LlmModule');
        switch (env.LLM_PROVIDER) {
          case 'github':
            if (!env.GITHUB_TOKEN) throw new Error('LLM_PROVIDER=github but GITHUB_TOKEN not set.');
            return github;
          case 'openai':
            if (!env.OPENAI_API_KEY) throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY not set.');
            return openai;
          case 'anthropic':
            if (!env.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY not set.');
            return anthropic;
          case 'azure-aifoundry':
            if (!env.LLM_API_KEY) throw new Error('LLM_PROVIDER=azure-aifoundry but LLM_API_KEY not set.');
            return azure;
          case 'local':
            logger.log('Using local template-based agent generator (deterministic, no external LLM API).');
            return local;
          default:
            // env.ts enum forbids any other value, but in production we want
            // explicit failure if someone bypasses the schema (env override).
            if (env.NODE_ENV === 'production') {
              throw new Error(`Unsupported LLM_PROVIDER=${env.LLM_PROVIDER}. Set local|github|openai|anthropic|azure-aifoundry.`);
            }
            logger.warn(`Unknown LLM_PROVIDER=${env.LLM_PROVIDER}; falling back to local generator.`);
            return local;
        }
      },
    },
  ],
  exports: [LLM_PROVIDER_TOKEN, LocalTemplateAgentGenerator, LlmCacheService],
})
export class LlmModule {}