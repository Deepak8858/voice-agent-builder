import { Global, Module } from '@nestjs/common';
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
    LlmCacheService,
    GithubModelsLlmAdapter,
    OpenAiLlmAdapter,
    AnthropicLlmAdapter,
    AzureAiFoundryAdapter,
    {
      provide: LLM_PROVIDER_TOKEN,
      inject: [GithubModelsLlmAdapter, OpenAiLlmAdapter, AnthropicLlmAdapter, AzureAiFoundryAdapter],
      useFactory: (
        github: GithubModelsLlmAdapter,
        openai: OpenAiLlmAdapter,
        anthropic: AnthropicLlmAdapter,
        azure: AzureAiFoundryAdapter,
      ): LlmAgentGenerator => {
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
          default:
            throw new Error(`Unsupported LLM_PROVIDER: ${env.LLM_PROVIDER}. Choose one of: github, openai, anthropic, azure-aifoundry.`);
        }
      },
    },
  ],
  exports: [LLM_PROVIDER_TOKEN, LlmCacheService],
})
export class LlmModule {}
