import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must be top-level so vitest hoists the mock before any imports.
vi.mock('../../config/env', () => ({
  env: {
    GITHUB_TOKEN: 'mock-github-token-for-tests',
    LLM_BASE_URL: undefined,
    LLM_MODEL: undefined,
    NODE_ENV: 'test',
  },
}));

import { GithubModelsLlmAdapter } from './github-models.adapter';
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

describe('GithubModelsLlmAdapter.chatGenerate', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalToken = env.GITHUB_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = originalToken;
  });

  it('throws when GITHUB_TOKEN is not set', async () => {
    (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = undefined;
    const adapter = new GithubModelsLlmAdapter();

    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('GITHUB_TOKEN not set');
  });

  it('posts to the default GitHub Models endpoint/model with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      chatCompletionResponse({ assistant_message: 'Here is your agent.', spec: VALID_SPEC }),
    );
    globalThis.fetch = fetchMock;

    const adapter = new GithubModelsLlmAdapter();
    const result = await adapter.chatGenerate(CHAT_INPUT);

    expect(result.assistant_message).toBe('Here is your agent.');
    expect(result.spec.name).toBe(VALID_SPEC.name);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://models.github.ai/inference/chat/completions');
    expect(options.headers['Authorization']).toBe('Bearer mock-github-token-for-tests');

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('openai/gpt-4o-mini');
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

    const adapter = new GithubModelsLlmAdapter();
    const result = await adapter.chatGenerate(CHAT_INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.assistant_message).toBe('Fixed it.');
  });

  it('throws HTTP status details on a non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    );

    const adapter = new GithubModelsLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('HTTP 403');
  });

  it('throws when the response has no choices[0].message.content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));

    const adapter = new GithubModelsLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow('Empty model response');
  });

  it('throws with the provider name when both attempts fail validation', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      chatCompletionResponse({ assistant_message: 'still broken', spec: { nope: true } }),
    );

    const adapter = new GithubModelsLlmAdapter();
    await expect(adapter.chatGenerate(CHAT_INPUT)).rejects.toThrow(
      /github returned an invalid Agent Spec after self-repair/,
    );
  });
});