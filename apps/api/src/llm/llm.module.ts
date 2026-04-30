import { Global, Module } from '@nestjs/common';
import { MockAgentGeneratorService } from '../agents/mock-generator.service';
import { env } from '../config/env';
import { AzureAiFoundryAdapter } from './adapters/azure-aifoundry.adapter';
import { GithubModelsLlmAdapter } from './adapters/github-models.adapter';
import { MockLlmAdapter } from './adapters/mock-llm.adapter';
import { OpenAiLlmAdapter } from './adapters/openai.adapter';
import { LlmCacheService } from './llm-cache.service';
import { LLM_PROVIDER_TOKEN, type LlmAgentGenerator } from './llm.provider.interface';

@Global()
@Module({
  providers: [
    MockAgentGeneratorService,
    LlmCacheService,
    MockLlmAdapter,
    GithubModelsLlmAdapter,
    OpenAiLlmAdapter,
    AzureAiFoundryAdapter,
    {
      provide: LLM_PROVIDER_TOKEN,
      inject: [MockLlmAdapter, GithubModelsLlmAdapter, OpenAiLlmAdapter, AzureAiFoundryAdapter],
      useFactory: (
        mock: MockLlmAdapter,
        github: GithubModelsLlmAdapter,
        openai: OpenAiLlmAdapter,
        azure: AzureAiFoundryAdapter,
      ): LlmAgentGenerator => {
        switch (env.LLM_PROVIDER) {
          case 'github':
            return github;
          case 'openai':
            return openai;
          case 'azure-aifoundry':
            return azure;
          case 'mock':
          default:
            return mock;
        }
      },
    },
  ],
  exports: [LLM_PROVIDER_TOKEN, MockAgentGeneratorService, LlmCacheService],
})
export class LlmModule {}
