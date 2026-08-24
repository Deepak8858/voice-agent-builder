import { createHash } from 'node:crypto';
import { llm } from '@livekit/agents';
import type { AgentSpec } from '@voiceforge/shared';
import { z } from 'zod';

/**
 * Wraps workspace Google tools (Calendar, Gmail, Sheets) as LiveKit LLM tools
 * that call the internal tool-invocation endpoint, following the pattern of
 * createKnowledgeTool in knowledge-retrieval.ts.
 *
 * Failure containment is the contract here: whatever goes wrong — timeout,
 * non-2xx, executor failure, reauth — the execute callback returns a
 * structured `{ ok: false, fallback_message }` result and never throws into
 * the LLM turn, so a broken integration can never crash a live call.
 */

/**
 * Must exceed the API's own outbound budget (safeFetch defaults to a 10s
 * ceiling per Google call), otherwise this client aborts while the server
 * is still working and every slow-but-successful invocation is reported to
 * the caller as a failure.
 */
const REQUEST_TIMEOUT_MS = 15_000;

const GENERIC_FALLBACK =
  'The tool could not complete right now. Continue the conversation and offer to follow up.';
const REAUTH_FALLBACK =
  'The Google integration needs to be reconnected by the business. Let the caller know this action cannot be completed right now.';

const InvokeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.enum(['pending', 'success', 'failed']),
    result: z.unknown().nullable(),
    error_message: z.string().nullable(),
  }),
});

export interface ToolInvoker {
  (
    toolName: string,
    params: Record<string, unknown>,
    toolType?: string,
  ): Promise<{
    status: 'pending' | 'success' | 'failed';
    result: unknown;
    errorMessage: string | null;
  }>;
}

export function createToolInvokeClient(config: {
  apiBaseUrl: string;
  internalApiKey: string;
  agentId: string;
  callId?: string;
  fetchImpl?: typeof fetch;
}): ToolInvoker {
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;

  return async (toolName, params, toolType) => {
    const response = await fetchImpl(
      `${baseUrl}/api/v1/internal/livekit/agents/${encodeURIComponent(config.agentId)}/tools/invoke`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': config.internalApiKey,
        },
        body: JSON.stringify({
          tool_name: toolName,
          params,
          ...(config.callId ? { call_id: config.callId } : {}),
          ...(config.callId && toolType === 'google_calendar' && params.operation === 'create_event'
            ? {
                idempotency_key: createHash('sha256')
                  .update(`${config.callId}:${toolName}:${stableJson(params)}`)
                  .digest('hex'),
              }
            : {}),
          // Declared tool type from the Agent Spec, so the API can refuse a
          // same-named tool of a different type.
          ...(toolType ? { tool_type: toolType } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new Error(`Tool invoke API returned ${response.status}.`);
    }
    const parsed = InvokeResponseSchema.parse(await response.json());
    return {
      status: parsed.data.status,
      result: parsed.data.result,
      errorMessage: parsed.data.error_message,
    };
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const GOOGLE_TOOL_PERMISSIONS = new Set(['google_calendar', 'gmail', 'google_sheets']);

interface GoogleToolParameterShapes {
  [toolType: string]: z.ZodTypeAny;
}

/**
 * Typed parameter schemas per Google tool type. The realtime model needs a
 * concrete shape to fill; a free-form record makes it guess badly.
 */
const PARAMETER_SHAPES: GoogleToolParameterShapes = {
  google_calendar: z.object({
    operation: z
      .enum(['create_event', 'list_events', 'find_free_slot'])
      .describe('Calendar operation to perform.'),
    summary: z.string().optional().describe('Event title, required for create_event.'),
    start_iso: z.string().optional().describe('Event start as ISO 8601 datetime.'),
    end_iso: z.string().optional().describe('Event end as ISO 8601 datetime.'),
    time_zone: z.string().optional().describe('IANA time zone, defaults to UTC.'),
    attendees: z.array(z.string()).optional().describe('Attendee email addresses.'),
    description: z.string().optional().describe('Optional event description.'),
    duration_minutes: z.number().optional().describe('Slot length for find_free_slot.'),
  }),
  gmail: z.object({
    to: z.string().describe('Recipient email address.'),
    subject: z.string().describe('Email subject line.'),
    body: z.string().describe('Plain-text email body.'),
  }),
  google_sheets: z.object({
    values: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .describe('Cell values for the new row, in column order.'),
    spreadsheet_id: z.string().optional().describe('Target spreadsheet id, if not preconfigured.'),
    sheet_name: z.string().optional().describe('Target sheet (tab) name.'),
  }),
};

function isReauthMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  const lowered = message.toLowerCase();
  return lowered.includes('reconnect') || lowered.includes('re-connect');
}

function googleToolType(tool: AgentSpec['tools'][number]): string | undefined {
  return tool.permissions?.find((permission) => GOOGLE_TOOL_PERMISSIONS.has(permission));
}

/**
 * Builds one LiveKit tool per enabled Google tool in the Agent Spec. Tools
 * are matched by their `permissions` entry, which agents.service.ts sets to
 * the IntegrationTool's toolType when merging referenced tools into specs.
 */
export function createGoogleTools(config: {
  spec: AgentSpec;
  invoke: ToolInvoker;
}): llm.ToolContextEntry[] {
  const tools: llm.ToolContextEntry[] = [];

  for (const specTool of config.spec.tools) {
    const toolType = googleToolType(specTool);
    if (!toolType) continue;
    const parameters = PARAMETER_SHAPES[toolType];
    if (!parameters) continue;

    tools.push(
      llm.tool({
        name: specTool.name,
        description: specTool.description,
        parameters: parameters as never,
        execute: async (params: Record<string, unknown>) => {
          try {
            const outcome = await config.invoke(specTool.name, params, toolType);
            if (outcome.status === 'success') {
              return { ok: true, result: outcome.result };
            }
            if (isReauthMessage(outcome.errorMessage)) {
              return { ok: false, fallback_message: REAUTH_FALLBACK };
            }
            return { ok: false, fallback_message: GENERIC_FALLBACK };
          } catch (err) {
            // Timeout, network failure, non-2xx, or malformed response.
            // Never throw into the LLM turn — but leave a trace for operators,
            // since the caller only ever sees the generic fallback.
            console.warn(
              `[google-tools] tool "${specTool.name}" invocation failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return { ok: false, fallback_message: GENERIC_FALLBACK };
          }
        },
      }),
    );
  }

  return tools;
}
