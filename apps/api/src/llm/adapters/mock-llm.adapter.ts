import { Injectable } from '@nestjs/common';
import type { GenerateAgentDto, GenerateAgentResult } from '@voiceforge/shared';
import { MockAgentGeneratorService } from '../../agents/mock-generator.service';
import type { LlmAgentGenerator } from '../llm.provider.interface';

/**
 * Mock LLM adapter. Wraps the deterministic, no-network template-merge
 * generator so the system can always fall back to a working baseline.
 */
@Injectable()
export class MockLlmAdapter implements LlmAgentGenerator {
  readonly name = 'mock';

  constructor(private readonly mock: MockAgentGeneratorService) {}

  async generate(input: GenerateAgentDto): Promise<GenerateAgentResult> {
    return this.mock.generate(input);
  }
}
