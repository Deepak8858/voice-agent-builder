import { llm } from '@livekit/agents';
import {
  ReminderResponseSchema,
  type ReminderRequest,
  type ReminderResponse,
} from '@voiceforge/shared';
import { z } from 'zod';

/**
 * `schedule_reminder`: a reminder or callback on the business's Google
 * Calendar, offered on every call of a workspace whose Google connection has
 * the calendar scope. Synchronous on purpose: the caller is told the time was
 * booked, so the model must know whether it was.
 */

const EnvelopeSchema = z.object({ success: z.literal(true), data: ReminderResponseSchema });

export type ReminderScheduler = (input: ReminderRequest) => Promise<ReminderResponse>;

export function createReminderClient(config: {
  apiBaseUrl: string;
  internalApiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ReminderScheduler {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;
  return async (input) => {
    const response = await fetchImpl(`${baseUrl}/api/v1/internal/runtime/reminders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': config.internalApiKey },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`[reminders] endpoint returned ${response.status}.`);
    return EnvelopeSchema.parse(await response.json()).data;
  };
}

export function createReminderTool(config: {
  agentId: string;
  callId: string;
  schedule: ReminderScheduler;
}): llm.ToolContextEntry {
  return llm.tool({
    name: 'schedule_reminder',
    description:
      'Book a reminder or callback on the business calendar at a specific date and time the caller agreed to. Use an absolute ISO 8601 date-time with the timezone offset. Confirm the time with the caller before calling this.',
    parameters: z.object({
      when_iso: z
        .string()
        .min(10)
        .describe('Absolute date-time with offset, e.g. 2026-09-03T10:00:00+05:30'),
      title: z.string().trim().min(1).max(120).describe('Short title: what the reminder is for.'),
      notes: z
        .string()
        .trim()
        .max(1000)
        .optional()
        .describe('Anything the person handling it should know.'),
      timezone: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe('IANA timezone of the caller, e.g. Asia/Kolkata.'),
    }),
    execute: async ({ when_iso, title, notes, timezone }) => {
      if (Number.isNaN(new Date(when_iso).getTime())) {
        return {
          scheduled: false,
          instruction:
            'The date and time was not understood. Ask the caller for the exact day and time again.',
        };
      }
      try {
        const result = await config.schedule({
          callId: config.callId,
          agentId: config.agentId,
          when_iso,
          title,
          ...(notes ? { notes } : {}),
          ...(timezone ? { timezone } : {}),
        });
        return result.scheduled
          ? {
              scheduled: true,
              instruction: 'Confirm the day and time back to the caller in one sentence.',
            }
          : {
              scheduled: false,
              instruction:
                'The reminder could not be booked right now. Apologise briefly and offer to note it down for a colleague instead.',
            };
      } catch (err) {
        console.warn(
          `[reminders] scheduling failed for call ${config.callId}: ${(err as Error).message}`,
        );
        return {
          scheduled: false,
          instruction:
            'The reminder could not be booked right now. Apologise briefly and offer to note it down for a colleague instead.',
        };
      }
    },
  });
}
