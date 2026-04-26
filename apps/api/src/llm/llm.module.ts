import { Global, Module } from '@nestjs/common';
import { MockAgentGeneratorService } from '../agents/mock-generator.service';
import { env } from '../config/env';
import { GithubModelsLlmAdapter } from './adapters/github-models.adapter';
import { MockLlmAdapter } from './adapters/mock-llm.adapter';
import { OpenAiLlmAdapter } from './adapters/openai.adapter';
import { LLM_PROVIDER_TOKEN, type LlmAgentGenerator } from './llm.provider.interface';

@Global()
@Module({
  providers: [
    MockAgentGeneratorService,
    MockLlmAdapter,
    GithubModelsLlmAdapter,
    OpenAiLlmAdapter,
    {
      provide: LLM_PROVIDER_TOKEN,
      inject: [MockLlmAdapter, GithubModelsLlmAdapter, OpenAiLlmAdapter],
      useFactory: (
        mock: MockLlmAdapter,
        github: GithubModelsLlmAdapter,
        openai: OpenAiLlmAdapter,
      ): LlmAgentGenerator => {
        switch (env.LLM_PROVIDER) {
          case 'github':
            return github;
          case 'openai':
            return openai;
          case 'mock':
          default:
            return mock;
        }
      },
    },
  ],
  exports: [LLM_PROVIDER_TOKEN, MockAgentGeneratorService],
})
export class LlmModule {}
