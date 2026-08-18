import { Logger } from '@nestjs/common';
import {
  AgentSpecSchema,
  MVP_TEMPLATES,
  findTemplateBySlug,
  type AgentSpec,
  type AgentTemplateSeed,
  type ChatGenerateResult,
  type GenerateAgentDto,
} from '@voiceforge/shared';
import type { ChatGenerateInput } from './llm.provider.interface';

export const CHAT_GEN_TIMEOUT_MS = 60_000;
/** Only the most recent turns are sent to the model to bound token usage. */
export const CHAT_GEN_MAX_HISTORY = 20;

export interface OpenAiCompatTarget {
  /** Full chat-completions URL (may include ?api-version=...). */
  url: string;
  headers: Record<string, string>;
  model: string;
  providerName: string;
  /** Null omits sampling temperature for models that only accept fixed defaults. */
  temperature?: number | null;
}

export interface ChatMessage {
  role: string;
  content: string;
}

/** Provider-specific transport: takes the built message array, returns parsed model JSON. */
export type ChatModelCaller = (messages: ChatMessage[]) => Promise<unknown>;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const logger = new Logger('ChatGeneration');

export function pickTemplate(templateSlug?: string): AgentTemplateSeed {
  if (templateSlug) {
    const direct = findTemplateBySlug(templateSlug);
    if (direct) return direct;
  }
  return MVP_TEMPLATES[0]!;
}

/**
 * Agent Spec v1.0 contract lines shared by every prompt (chat and one-shot
 * generate). Kept in one place so a fix reaches all providers at once. The
 * allowed_call_window line names all three required subfields and their types,
 * because a partial window is what the model emits when the fields are unnamed.
 */
export const SPEC_CONTRACT_INSTRUCTIONS = [
  'Required top-level keys: schema_version="1.0", name, industry, agent_type, language, voice, identity, goals, required_fields, conversation_rules, knowledge, tools, handoff, compliance, analytics.',
  'agent_type \u2208 inbound_receptionist | outbound_reminder | outbound_qualifier | outbound_confirmation | outbound_survey.',
  'For outbound_* types, set compliance.consent_required_for_outbound=true. Either omit compliance.allowed_call_window entirely, or include it complete with all three fields: timezone (IANA name string, e.g. "America/Los_Angeles"), start_hour (integer 0-23), and end_hour (integer 0-23). Never send a partial allowed_call_window.',
  'handoff.enabled=true requires handoff.conditions[]>=1.',
  'voice.tone is required. identity.business_name and identity.agent_name are required.',
  'goals must be a non-empty string array. tools[] each need {name, description, requires_confirmation, input_schema:{type:"object",properties,required}}.',
];

export function buildChatSystemPrompt(): string {
  return [
    'You are VoiceForge AI, a conversational voice-agent designer.',
    'You collaborate with the user over multiple turns to design a phone voice agent.',
    'Every reply MUST be a single JSON object: {"assistant_message": string, "spec": object}.',
    '"assistant_message" is a short, friendly reply for the chat thread: acknowledge what you changed or ask ONE clarifying question if truly necessary. Never include JSON in it.',
    '"spec" is the complete, updated Agent Spec v1.0 object (never a partial diff).',
    ...SPEC_CONTRACT_INSTRUCTIONS,
    'When the user asks for changes, modify ONLY what they asked for and keep everything else stable.',
    'Do NOT invent fields outside the schema. Do NOT include markdown fences. Output JSON only.',
  ].join('\n');
}

/** System prompt for the one-shot `generate()` path (returns a bare Agent Spec). */
export function buildGenerateSystemPrompt(): string {
  return [
    'You are VoiceForge AI, a generator of provider-neutral voice agent specifications.',
    'Return ONLY a JSON object that satisfies the Agent Spec v1.0 contract.',
    ...SPEC_CONTRACT_INSTRUCTIONS,
    'Do NOT invent fields outside the schema. Do NOT include markdown fences. Output JSON only.',
  ].join('\n');
}

/** User prompt for the one-shot `generate()` path, seeded with a template. */
export function buildGenerateUserPrompt(input: GenerateAgentDto, baseSpec: AgentSpec): string {
  const ctx = input.business_context ?? {};
  return [
    `User prompt: ${input.prompt}`,
    ctx.business_name ? `Business name: ${ctx.business_name}` : '',
    ctx.industry_hint ? `Industry hint: ${ctx.industry_hint}` : '',
    ctx.timezone ? `Timezone: ${ctx.timezone}` : '',
    input.knowledge_source_ids?.length
      ? `Attach these knowledge_source_ids on knowledge.source_ids: ${JSON.stringify(input.knowledge_source_ids)}`
      : '',
    `Use the following template as the starting point and tailor it to the prompt:`,
    JSON.stringify(baseSpec, null, 2),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Builds the OpenAI-style message array from session history. The current
 * spec (if any) is injected before the latest user turn so the model refines
 * rather than regenerates; otherwise a template seed is provided.
 */
export function buildChatMessages(input: ChatGenerateInput): ChatMessage[] {
  const history = input.messages.slice(-CHAT_GEN_MAX_HISTORY);
  const messages: ChatMessage[] = [{ role: 'system', content: buildChatSystemPrompt() }];

  if (input.currentSpec) {
    messages.push({
      role: 'system',
      content: `Current Agent Spec (refine this, do not start over):\n${JSON.stringify(input.currentSpec)}`,
    });
  } else {
    const seed = pickTemplate(input.template_slug);
    messages.push({
      role: 'system',
      content: `No spec exists yet. Use this template as the starting seed and tailor it to the user's request:\n${JSON.stringify(seed.spec as AgentSpec)}`,
    });
  }

  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }
  return messages;
}

export function parseModelJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Non-JSON response from model: ${content.slice(0, 120)}`);
  }
}

async function callOpenAiCompat(
  target: OpenAiCompatTarget,
  messages: ChatMessage[],
): Promise<unknown> {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...target.headers,
    },
    body: JSON.stringify({
      model: target.model,
      ...(target.temperature === null ? {} : { temperature: target.temperature ?? 0.3 }),
      response_format: { type: 'json_object' },
      messages,
    }),
    signal: AbortSignal.timeout(CHAT_GEN_TIMEOUT_MS),
  });

  // Cloudflare AI Gateway attaches a log id; surface it for traceability.
  const gatewayLogId = res.headers.get('cf-aig-log-id');
  if (gatewayLogId) {
    logger.log(`[${target.providerName}] ai-gateway log id: ${gatewayLogId}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} \u2014 ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as ChatCompletionResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty model response (no choices[0].message.content).');
  return parseModelJson(content);
}

/** Builds a `ChatModelCaller` for an OpenAI-compatible chat-completions target. */
export function openAiCompatCaller(target: OpenAiCompatTarget): ChatModelCaller {
  return (messages) => callOpenAiCompat(target, messages);
}

function validateChatResult(
  raw: unknown,
): { ok: true; result: ChatGenerateResult } | { ok: false; issues: string } {
  const obj = raw as { assistant_message?: unknown; spec?: unknown };
  const assistantMessage =
    typeof obj?.assistant_message === 'string' && obj.assistant_message.trim().length > 0
      ? obj.assistant_message.trim()
      : null;
  const specParse = AgentSpecSchema.safeParse(obj?.spec);
  if (assistantMessage && specParse.success) {
    return { ok: true, result: { assistant_message: assistantMessage, spec: specParse.data } };
  }
  const issues = [
    assistantMessage ? null : 'assistant_message must be a non-empty string',
    specParse.success
      ? null
      : `spec failed Agent Spec v1.0 validation: ${specParse.error.message.slice(0, 1500)}`,
  ]
    .filter(Boolean)
    .join('; ');
  return { ok: false, issues };
}

/**
 * Runs chat generation with a provider-specific transport and one self-repair
 * retry: if the first response fails validation, the Zod issues are fed back
 * to the model so it can correct itself.
 */
export async function runChatGenerationWith(
  providerName: string,
  call: ChatModelCaller,
  input: ChatGenerateInput,
): Promise<ChatGenerateResult> {
  const messages = buildChatMessages(input);

  const first = await call(messages);
  const firstCheck = validateChatResult(first);
  if (firstCheck.ok === true) return firstCheck.result;

  // Explicit narrowing: from here on firstCheck is the failure variant.
  const firstIssues = firstCheck.issues;
  logger.warn(
    `[${providerName}] invalid chat result, attempting self-repair: ${firstIssues.slice(0, 300)}`,
  );

  const repairMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: JSON.stringify(first).slice(0, 12_000) },
    {
      role: 'user',
      content: [
        'Your previous response failed validation with these issues:',
        firstIssues,
        'Return the corrected full JSON object {"assistant_message", "spec"} that fixes ALL issues. JSON only.',
      ].join('\n'),
    },
  ];

  const second = await call(repairMessages);
  const secondCheck = validateChatResult(second);
  if (secondCheck.ok === true) return secondCheck.result;

  throw new Error(
    `${providerName} returned an invalid Agent Spec after self-repair: ${secondCheck.issues.slice(0, 500)}`,
  );
}

/**
 * Convenience wrapper for OpenAI-compatible chat-completions endpoints
 * (OpenAI, Azure AI Foundry, GitHub Models, Cloudflare AI Gateway routes).
 */
export async function runChatGeneration(
  target: OpenAiCompatTarget,
  input: ChatGenerateInput,
): Promise<ChatGenerateResult> {
  return runChatGenerationWith(target.providerName, openAiCompatCaller(target), input);
}

export interface AgentGenerationResult {
  spec: AgentSpec;
  /** True when validation still failed after self-repair and the seed template was used. */
  usedFallback: boolean;
}

/**
 * Runs the one-shot `generate()` path with a provider-specific transport, one
 * self-repair retry, and a final fall back to the seed template. This keeps a
 * non-deterministic model response from reaching the user as a 500: a bad first
 * response is fed its own Zod issues for a second try, and if that still fails
 * the already-selected seed template (a known-valid spec) is returned.
 *
 * Transport errors (HTTP, non-JSON) are NOT caught — they propagate so the
 * caller learns the real provider failed.
 */
export async function runAgentGenerationWith(
  providerName: string,
  call: ChatModelCaller,
  input: GenerateAgentDto,
  base: AgentTemplateSeed,
): Promise<AgentGenerationResult> {
  const baseSpec = base.spec as AgentSpec;
  const messages: ChatMessage[] = [
    { role: 'system', content: buildGenerateSystemPrompt() },
    { role: 'user', content: buildGenerateUserPrompt(input, baseSpec) },
  ];

  const first = await call(messages);
  const firstParse = AgentSpecSchema.safeParse(first);
  if (firstParse.success) return { spec: firstParse.data, usedFallback: false };

  logger.warn(
    `[${providerName}] invalid Agent Spec, attempting self-repair: ${firstParse.error.message.slice(0, 300)}`,
  );

  const repairMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: JSON.stringify(first).slice(0, 12_000) },
    {
      role: 'user',
      content: [
        'Your previous response failed Agent Spec v1.0 validation with these issues:',
        firstParse.error.message.slice(0, 1500),
        'Return the corrected full Agent Spec JSON object that fixes ALL issues. JSON only.',
      ].join('\n'),
    },
  ];

  const second = await call(repairMessages);
  const secondParse = AgentSpecSchema.safeParse(second);
  if (secondParse.success) return { spec: secondParse.data, usedFallback: false };

  logger.warn(
    `[${providerName}] Agent Spec still invalid after self-repair; falling back to seed template "${base.slug}": ${secondParse.error.message.slice(0, 300)}`,
  );
  const fallbackParse = AgentSpecSchema.safeParse(baseSpec);
  if (!fallbackParse.success) {
    // Seed templates are validated in tests, so this is unreachable in practice.
    throw new Error(
      `${providerName} returned an invalid Agent Spec and the seed template "${base.slug}" is itself invalid: ${fallbackParse.error.message.slice(0, 300)}`,
    );
  }
  return { spec: fallbackParse.data, usedFallback: true };
}
