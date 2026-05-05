import type { GenerateAgentDto, GenerateAgentResult } from '@voiceforge/shared';

export interface LlmAgentGenerator {
  readonly name: string;
  generate(input: GenerateAgentDto): Promise<GenerateAgentResult>;
  /** Returns 'ok' if the LLM provider is reachable, 'unavailable' otherwise. */
  healthCheck?(): Promise<'ok' | 'unavailable'>;
}

export const LLM_PROVIDER_TOKEN = Symbol.for('LLM_PROVIDER_TOKEN');