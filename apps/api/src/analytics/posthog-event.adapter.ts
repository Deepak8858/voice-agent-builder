import {
  CallDirectionSchema,
  CallOutcomeSchema,
  ComplianceReasonCodeSchema,
  type CallDirection,
  type CallOutcome,
  type ComplianceReasonCode,
} from '@voiceforge/shared';
import type { TypedPostHogEvent } from '../posthog/posthog.service';

export interface InternalAnalyticsEventInput {
  agentId?: string | null;
  callId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}

/**
 * Translates an internal `AnalyticsService.recordEventInternal` event into the
 * typed PostHog event union.
 *
 * Only the three call lifecycle events are forwarded. Everything else —
 * including the dynamic `outcome.${outcome}` events and any future internal
 * event type — returns `null` and is dropped.
 *
 * Properties are rebuilt field by field from an allowlist; the internal payload
 * is never spread. Internal `call.started`/`call.blocked` payloads carry a raw
 * `to_number`, so copying the payload would leak PII even though
 * `buildPostHogEvent` would strip it downstream.
 */
export function toPostHogEvent(
  input: InternalAnalyticsEventInput,
): TypedPostHogEvent | null {
  const payload = input.payload ?? {};

  switch (input.eventType) {
    case 'call.started':
      return {
        event: 'call_started',
        properties: {
          ...idProperties(input),
          direction: direction(payload.direction) ?? 'outbound',
        },
      };
    case 'call.ended': {
      const outcome = callOutcome(payload.outcome);
      const durationSeconds = positiveInteger(payload.duration_seconds);
      return {
        event: 'call_ended',
        properties: {
          ...idProperties(input),
          direction: direction(payload.direction) ?? 'outbound',
          ...(outcome ? { outcome } : {}),
          ...(durationSeconds === null ? {} : { duration_seconds: durationSeconds }),
        },
      };
    }
    case 'call.blocked': {
      // A malformed `reasons` value drops the event rather than misreporting
      // zero compliance reasons.
      const codes = reasonCodes(payload.reasons);
      if (!codes) return null;
      return {
        event: 'call_blocked',
        properties: {
          ...(input.agentId ? { agent_id: input.agentId } : {}),
          direction: direction(payload.direction) ?? 'outbound',
          reason_codes: codes,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * The opaque per-event ID used as the non-person distinct ID. Normally the call
 * ID; a pre-call compliance block has no call row yet, so the compliance check
 * ID stands in. Returns null when neither is available, which drops the event.
 */
export function eventScopeIdFor(input: InternalAnalyticsEventInput): string | null {
  if (input.callId) return input.callId;
  const checkId = input.payload?.compliance_check_id;
  return typeof checkId === 'string' && checkId.length > 0 ? checkId : null;
}

function idProperties(input: InternalAnalyticsEventInput): {
  call_id?: string;
  agent_id?: string;
} {
  return {
    ...(input.callId ? { call_id: input.callId } : {}),
    ...(input.agentId ? { agent_id: input.agentId } : {}),
  };
}

function direction(value: unknown): CallDirection | null {
  const parsed = CallDirectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function callOutcome(value: unknown): CallOutcome | null {
  const parsed = CallOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Compliance reasons are `{ code, message, severity }`; only the code is safe —
 * `message` is operator-facing free text that can embed the dialled number.
 * Returns null when the value is not a well-formed reason list.
 */
function reasonCodes(value: unknown): ComplianceReasonCode[] | null {
  if (!Array.isArray(value)) return null;
  const codes: ComplianceReasonCode[] = [];
  for (const entry of value) {
    const code = (entry as { code?: unknown } | null)?.code;
    const parsed = ComplianceReasonCodeSchema.safeParse(code);
    if (!parsed.success) return null;
    codes.push(parsed.data);
  }
  return codes;
}
