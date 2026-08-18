import type {
  AgentGenMessage,
  ChatGenerateResult,
  GenerateAgentDto,
  GenerateAgentResult,
} from '@voiceforge/shared';

export interface ChatGenerateInput {
  /** Prior conversation turns, oldest first. Callers should cap history length. */
  messages: AgentGenMessage[];
  /** The spec produced so far, if any — the model refines it instead of starting over. */
  currentSpec?: unknown;
  template_slug?: string;
}

export interface LlmAgentGenerator {
  readonly name: string;
  generate(input: GenerateAgentDto): Promise<GenerateAgentResult>;
  /**
   * Multi-turn conversational generation. Given the chat history and the
   * current spec, returns the assistant's reply plus a full updated Agent
   * Spec that satisfies AgentSpecSchema.
   */
  chatGenerate(input: ChatGenerateInput): Promise<ChatGenerateResult>;
  /** Returns 'ok' if the LLM provider is reachable, 'unavailable' otherwise. */
  healthCheck?(): Promise<'ok' | 'unavailable'>;
}

export const LLM_PROVIDER_TOKEN = Symbol.for('LLM_PROVIDER_TOKEN');
