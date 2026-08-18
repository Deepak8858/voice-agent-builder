import { describe, expect, it, vi } from 'vitest';
import { AgentSpecSchema, MVP_TEMPLATES, type AgentGenMessage, type AgentSpec } from '@voiceforge/shared';
import {
  CHAT_GEN_MAX_HISTORY,
  buildChatMessages,
  buildGenerateSystemPrompt,
  pickTemplate,
  parseModelJson,
  runAgentGenerationWith,
  runChatGenerationWith,
  type ChatMessage,
} from './chat-generation';
import type { GenerateAgentDto } from '@voiceforge/shared';

/** A spec that actually satisfies AgentSpecSchema, built from the shipped template seed. */
const VALID_SPEC: AgentSpec = AgentSpecSchema.parse(MVP_TEMPLATES[0]!.spec);

function userTurn(content: string, at = '2026-01-01T00:00:00.000Z'): AgentGenMessage {
  return { role: 'user', content, at };
}

describe('buildChatMessages', () => {
  it('injects the current spec as a system message so the model refines instead of restarting', () => {
    const messages = buildChatMessages({
      messages: [userTurn('make the tone friendlier')],
      currentSpec: VALID_SPEC,
    });

    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('system');
    expect(messages[1]!.content).toContain('Current Agent Spec');
    expect(messages[1]!.content).toContain(JSON.stringify(VALID_SPEC));
    expect(messages[1]!.content).not.toContain('No spec exists yet');
  });

  it('seeds with a template when no spec exists yet', () => {
    const messages = buildChatMessages({
      messages: [userTurn('build me a dental receptionist')],
      template_slug: 'dental-receptionist',
    });

    expect(messages[1]!.content).toContain('No spec exists yet');
    expect(messages[1]!.content).toContain(JSON.stringify(pickTemplate('dental-receptionist').spec));
  });

  it('falls back to the first template when the slug is unknown', () => {
    const messages = buildChatMessages({
      messages: [userTurn('hello')],
      template_slug: 'does-not-exist',
    });

    expect(messages[1]!.content).toContain(JSON.stringify(MVP_TEMPLATES[0]!.spec));
  });

  it('caps history at CHAT_GEN_MAX_HISTORY and keeps the most recent turns', () => {
    const history: AgentGenMessage[] = Array.from({ length: CHAT_GEN_MAX_HISTORY + 5 }, (_, i) =>
      userTurn(`turn-${i}`),
    );

    const messages = buildChatMessages({ messages: history });
    const turns = messages.slice(2); // drop the two system messages

    expect(turns).toHaveLength(CHAT_GEN_MAX_HISTORY);
    expect(turns[0]!.content).toBe('turn-5');
    expect(turns.at(-1)!.content).toBe(`turn-${CHAT_GEN_MAX_HISTORY + 4}`);
  });

  it('preserves message roles from the session history', () => {
    const messages = buildChatMessages({
      messages: [
        userTurn('hi'),
        { role: 'assistant', content: 'here is a draft', at: '2026-01-01T00:00:01.000Z' },
      ],
    });

    expect(messages.slice(2).map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('parseModelJson', () => {
  it('parses a JSON payload', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('throws a descriptive error for non-JSON content', () => {
    expect(() => parseModelJson('sorry, I cannot do that')).toThrow(/Non-JSON response from model/);
  });
});

describe('runChatGenerationWith', () => {
  const input = { messages: [userTurn('create a receptionist')] };

  it('returns the parsed result when the first response is valid', async () => {
    const call = vi.fn().mockResolvedValue({ assistant_message: '  Done!  ', spec: VALID_SPEC });

    const result = await runChatGenerationWith('test-provider', call, input);

    expect(call).toHaveBeenCalledTimes(1);
    expect(result.assistant_message).toBe('Done!');
    expect(result.spec.name).toBe(VALID_SPEC.name);
  });

  it('self-repairs exactly once, feeding the validation issues back to the model', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ assistant_message: '', spec: { schema_version: 'nope' } })
      .mockResolvedValueOnce({ assistant_message: 'Fixed it.', spec: VALID_SPEC });

    const result = await runChatGenerationWith('test-provider', call, input);

    expect(call).toHaveBeenCalledTimes(2);
    expect(result.assistant_message).toBe('Fixed it.');

    const repairMessages = call.mock.calls[1]![0] as ChatMessage[];
    const firstMessages = call.mock.calls[0]![0] as ChatMessage[];
    // The repair turn is the original prompt plus the bad answer and the issues.
    expect(repairMessages.slice(0, firstMessages.length)).toEqual(firstMessages);
    expect(repairMessages.at(-2)!.role).toBe('assistant');

    const repairPrompt = repairMessages.at(-1)!;
    expect(repairPrompt.role).toBe('user');
    expect(repairPrompt.content).toContain('failed validation');
    expect(repairPrompt.content).toContain('assistant_message must be a non-empty string');
    expect(repairPrompt.content).toContain('spec failed Agent Spec v1.0 validation');
  });

  it('self-repairs when only the spec is invalid', async () => {
    const badSpec = { ...VALID_SPEC, handoff: { enabled: true, conditions: [] } };
    const call = vi
      .fn()
      .mockResolvedValueOnce({ assistant_message: 'Here you go.', spec: badSpec })
      .mockResolvedValueOnce({ assistant_message: 'Corrected.', spec: VALID_SPEC });

    await runChatGenerationWith('test-provider', call, input);

    const repairPrompt = (call.mock.calls[1]![0] as ChatMessage[]).at(-1)!;
    expect(repairPrompt.content).toContain('spec failed Agent Spec v1.0 validation');
    expect(repairPrompt.content).not.toContain('assistant_message must be a non-empty string');
  });

  it('throws with the provider name when the repaired response is still invalid', async () => {
    const call = vi.fn().mockResolvedValue({ assistant_message: 'still broken', spec: { nope: true } });

    await expect(runChatGenerationWith('azure-aifoundry', call, input)).rejects.toThrow(
      /azure-aifoundry returned an invalid Agent Spec after self-repair/,
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not swallow transport errors from the caller', async () => {
    const call = vi.fn().mockRejectedValue(new Error('HTTP 503 Service Unavailable'));

    await expect(runChatGenerationWith('openai', call, input)).rejects.toThrow('HTTP 503');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('buildGenerateSystemPrompt', () => {
  it('names the three required allowed_call_window subfields', () => {
    const prompt = buildGenerateSystemPrompt();
    expect(prompt).toContain('timezone');
    expect(prompt).toContain('start_hour');
    expect(prompt).toContain('end_hour');
    expect(prompt).toContain('Never send a partial allowed_call_window');
  });
});

describe('runAgentGenerationWith', () => {
  const base = MVP_TEMPLATES[0]!;
  const input: GenerateAgentDto = {
    prompt: 'Create a receptionist for a dental clinic',
    knowledge_source_ids: [],
  };

  it('returns the parsed spec when the first response is valid', async () => {
    const call = vi.fn().mockResolvedValue(VALID_SPEC);

    const result = await runAgentGenerationWith('test-provider', call, input, base);

    expect(call).toHaveBeenCalledTimes(1);
    expect(result.usedFallback).toBe(false);
    expect(result.spec.name).toBe(VALID_SPEC.name);
  });

  it('self-repairs once and returns the corrected spec', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ foo: 'bar' })
      .mockResolvedValueOnce(VALID_SPEC);

    const result = await runAgentGenerationWith('test-provider', call, input, base);

    expect(call).toHaveBeenCalledTimes(2);
    expect(result.usedFallback).toBe(false);
    const repairPrompt = (call.mock.calls[1]![0] as ChatMessage[]).at(-1)!;
    expect(repairPrompt.content).toContain('failed Agent Spec v1.0 validation');
  });

  it('falls back to the seed template when the spec stays invalid', async () => {
    const call = vi.fn().mockResolvedValue({ foo: 'bar' });

    const result = await runAgentGenerationWith('test-provider', call, input, base);

    expect(call).toHaveBeenCalledTimes(2);
    expect(result.usedFallback).toBe(true);
    expect(result.spec.name).toBe(AgentSpecSchema.parse(base.spec).name);
  });

  it('does not swallow transport errors from the caller', async () => {
    const call = vi.fn().mockRejectedValue(new Error('HTTP 503 Service Unavailable'));

    await expect(runAgentGenerationWith('openai', call, input, base)).rejects.toThrow('HTTP 503');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
