import { llm } from '@livekit/agents';
import {
  CallerDetailsResponseSchema,
  type AgentSpec,
  type CallerDetailsRequest,
  type CallerDetailsResponse,
} from '@voiceforge/shared';
import { z } from 'zod';

/**
 * `save_caller_details`: the agent's automatic Google Sheet, filled live.
 *
 * Registered only when the agent has a sheet (created at publish) and fields to
 * capture. The parameters are the agent's `required_fields`, all optional, so
 * the model can save whatever the caller has said so far and save again as
 * more arrives. The tool returns at once: the API merges the fields onto the
 * call and writes the sheet from a queue, so the caller never waits on Google.
 * Saves are posted in order so a correction cannot be overtaken by the value it
 * corrects.
 */

const EnvelopeSchema = z.object({ success: z.literal(true), data: CallerDetailsResponseSchema });

export type CallerDetailsSaver = (input: CallerDetailsRequest) => Promise<CallerDetailsResponse>;

export function createCallerDetailsClient(config: {
  apiBaseUrl: string;
  internalApiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CallerDetailsSaver {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;
  return async (input) => {
    const response = await fetchImpl(`${baseUrl}/api/v1/internal/runtime/caller-details`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': config.internalApiKey },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(config.timeoutMs ?? 8_000),
    });
    if (!response.ok) throw new Error(`[caller-details] endpoint returned ${response.status}.`);
    return EnvelopeSchema.parse(await response.json()).data;
  };
}

export function createCallerDetailsTool(config: {
  spec: AgentSpec;
  agentId: string;
  callId: string;
  /** Column keys of the agent's sheet; only these are accepted. */
  sheetColumns: string[];
  save: CallerDetailsSaver;
}): llm.ToolContextEntry | null {
  const columns = new Set(config.sheetColumns);
  const fields = config.spec.required_fields.filter((field) => columns.has(field.key));
  if (fields.length === 0) return null;

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    shape[field.key] = z
      .string()
      .max(500)
      .nullish()
      .describe(field.description ?? `${field.key} (${field.type})`);
  }

  // Saves for one call are chained so they reach the API in the order the
  // model made them; a failure is logged and never surfaces into the turn.
  let pending: Promise<unknown> = Promise.resolve();

  return llm.tool({
    name: 'save_caller_details',
    description:
      'Save the details the caller has given so far to the call record. Call it as soon as you have any of the fields and again whenever more arrive; leave fields you do not have yet out. Never wait until the end of the call.',
    parameters: z.object(shape),
    execute: async (args) => {
      const provided = Object.fromEntries(
        Object.entries(args as Record<string, unknown>).filter(
          ([, value]) => value !== null && value !== undefined && String(value).trim() !== '',
        ),
      ) as Record<string, string>;
      if (Object.keys(provided).length === 0) return { saved: false, reason: 'nothing_to_save' };
      pending = pending
        .then(() =>
          config.save({ callId: config.callId, agentId: config.agentId, fields: provided }),
        )
        .then((result) => {
          if (!result.saved) {
            console.warn(`[caller-details] not saved for call ${config.callId}: ${result.reason}`);
          }
        })
        .catch((err: unknown) => {
          console.warn(
            `[caller-details] save failed for call ${config.callId}: ${(err as Error).message}`,
          );
        });
      return { saved: true, fields: Object.keys(provided) };
    },
  });
}
