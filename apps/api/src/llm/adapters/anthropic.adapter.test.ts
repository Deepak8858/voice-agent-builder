import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must be top-level so vitest hoists the mock before any imports.
vi.mock('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'mock-anthropic-key-for-tests',
    ANTHROPIC_MODEL: undefined,
    NODE_ENV: 'test',
  },
}));

import { AnthropicLlmAdapter } from './anthropic.adapter';
import { env } from '../../config/env';
import { AgentSpecSchema, MVP_TEMPLATES, type AgentGenMessage, type AgentSpec } from '@voiceforge/shared';
import type { ChatGenerateInput } from '../llm.provider.interface';

const VALID_SPEC: AgentSpec = AgentSpecSchema.parse(MVP_TEMPLATES[0]!.spec);

function userTurn(content: string): AgentGenMessage {
  return { role: 'user', content, at: '2026-01-01T00:00:00.000Z' };
}

function anthropicResponse(payload: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    { status },
  );
}

const CHAT_INPUT: ChatGenerateInput = { messages: [userTurn('build me a dental receptionist')] };

describe('AnthropicLlmAdapter.chatGenerate', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = originalApiKey;
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = undefined;
    const adapter = new AnthropicLlmAdapter();

    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('ANTHROPIC_API_KEY not set');
  });

  it('hoists system messages into a single cached system field and posts the remaining turns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      anthropicResponse({ assistant_message: 'Here is your agent.', spec: VALID_SPEC }),
    );
    globalThis.fetch = fetchMock;

    const adapter = new AnthropicLlmAdapter();
    const result = await adapter.chatGenerate(CHAT_INPUT);

    expect(result.assistant_message).toBe('Here is your agent.');
    expect(result.spec.name).toBe(VALID_SPEC.name);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('mock-anthropic-key-for-tests');

    const body = JSON.parse(options.body as string);
    expect(body.system).toHaveLength(1);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text.length).toBeGreaterThan(0);
    // Only non-system turns should appear in `messages`.
    expect(body.messages).toEqual([{ role: 'user', content: 'build me a dental receptionist' }]);
  });

  it('self-repairs once when the first response fails Agent Spec validation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(anthropicResponse({ assistant_message: '', spec: { nope: true } }))
      .mockResolvedValueOnce(
        anthropicResponse({ assistant_message: 'Fixed it.', spec: VALID_SPEC }),
      );
    globalThis.fetch = fetchMock;

    const adapter = new AnthropicLlmAdapter();
    const result = await adapter.chatGenerate(CHAT_INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.assistant_message).toBe('Fixed it.');
  });

  it('throws when the model returns a non-JSON text block', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'not json at all' }] }),
        { status: 200 },
      ),
    );

    const adapter = new AnthropicLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('Non-JSON response from model');
  });

  it('throws when the response has no text content block', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'image' }] }), { status: 200 }),
    );

    const adapter = new AnthropicLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('Empty model response');
  });

  it('throws with the API error body on a non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );

    const adapter = new AnthropicLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('Anthropic API error 429');
  });

  it('throws with the provider name when both attempts fail validation', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      anthropicResponse({ assistant_message: 'still broken', spec: { nope: true } }),
    );

    const adapter = new AnthropicLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow(
      /anthropic returned an invalid Agent Spec after self-repair/,
    );
  });
});