import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must be top-level so vitest hoists the mock before any imports.
vi.mock('../../config/env', () => ({
  env: {
    OPENAI_API_KEY: 'mock-openai-key-for-tests',
    LLM_BASE_URL: undefined,
    LLM_MODEL: undefined,
    NODE_ENV: 'test',
  },
}));

import { OpenAiLlmAdapter } from './openai.adapter';
import { env } from '../../config/env';
import { AgentSpecSchema, MVP_TEMPLATES, type AgentGenMessage, type AgentSpec } from '@voiceforge/shared';
import type { ChatGenerateInput } from '../llm.provider.interface';

const VALID_SPEC: AgentSpec = AgentSpecSchema.parse(MVP_TEMPLATES[0]!.spec);

function userTurn(content: string): AgentGenMessage {
  return { role: 'user', content, at: '2026-01-01T00:00:00.000Z' };
}

function chatCompletionResponse(payload: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status },
  );
}

const CHAT_INPUT: ChatGenerateInput = { messages: [userTurn('build me a dental receptionist')] };

describe('OpenAiLlmAdapter.chatGenerate', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = env.OPENAI_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = originalApiKey;
  });

  it('throws when OPENAI_API_KEY is not set', async () => {
    (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = undefined;
    const adapter = new OpenAiLlmAdapter();

    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('OPENAI_API_KEY not set');
  });

  it('posts to the default endpoint/model with a bearer token and JSON mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      chatCompletionResponse({ assistant_message: 'Here is your agent.', spec: VALID_SPEC }),
    );
    globalThis.fetch = fetchMock;

    const adapter = new OpenAiLlmAdapter();
    const result = await adapter.chatGenerate(CHAT_INPUT);

    expect(result.assistant_message).toBe('Here is your agent.');
    expect(result.spec.name).toBe(VALID_SPEC.name);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(options.headers['Authorization']).toBe('Bearer mock-openai-key-for-tests');

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'build me a dental receptionist' });
  });

  it('self-repairs once when the first response fails Agent Spec validation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionResponse({ assistant_message: '', spec: { nope: true } }))
      .mockResolvedValueOnce(
        chatCompletionResponse({ assistant_message: 'Fixed it.', spec: VALID_SPEC }),
      );
    globalThis.fetch = fetchMock;

    const adapter = new OpenAiLlmAdapter();
    const result = await adapter.chatGenerate(CHAT_INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.assistant_message).toBe('Fixed it.');
  });

  it('throws HTTP status details on a non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('service unavailable', { status: 503, statusText: 'Service Unavailable' }),
    );

    const adapter = new OpenAiLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('HTTP 503');
  });

  it('throws when the response has no choices[0].message.content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));

    const adapter = new OpenAiLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('Empty model response');
  });

  it('strips the openai/ namespace prefix from LLM_MODEL when set', async () => {
    (env as { LLM_MODEL?: string }).LLM_MODEL = 'openai/gpt-4.1-mini';
    const fetchMock = vi.fn().mockResolvedValue(
      chatCompletionResponse({ assistant_message: 'ok', spec: VALID_SPEC }),
    );
    globalThis.fetch = fetchMock;

    const adapter = new OpenAiLlmAdapter();
    await adapter.chatGenerate(CHAT_INPUT);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.model).toBe('gpt-4.1-mini');
    (env as { LLM_MODEL?: string }).LLM_MODEL = undefined;
  });
});