import { z } from 'zod';
import { CallDirectionSchema } from '../schemas/call';
import { CallOutcomeSchema } from '../schemas/analytics';
import { ComplianceReasonCodeSchema } from '../schemas/compliance';

/**
 * PostHog event contract (V1).
 *
 * This module is the single privacy boundary between VoiceForge and PostHog.
 * Postgres `AnalyticsEvent` rows remain the tenant-facing system of record and
 * are unaffected by anything here.
 *
 * Design rules:
 *  1. The event vocabulary is a closed set. Unknown or dynamically-named events
 *     (for example `outcome.${outcome}`) are dropped, never forwarded.
 *  2. Every event has an explicit property schema. Schemas parse into a new
 *     object and admit only named fields with bounded types, so unknown keys —
 *     including `to_number`, `transcript` and `metadata` blobs that already
 *     exist in internal payloads — are stripped rather than passed through.
 *  3. `containsUnsafeValue` is defense in depth against a schema field being
 *     mis-populated with PII. It is not the primary sanitizer.
 *  4. Identity is explicit. Authenticated user actions use the app user ID;
 *     autonomous call lifecycle events use a non-person opaque ID and disable
 *     person profile processing. A workspace ID is never a person ID.
 */

// --- event vocabulary ---------------------------------------------------

export const POSTHOG_EVENT_NAMES = [
  'call_started',
  'call_ended',
  'call_blocked',
  'agent_created',
  'agent_published',
  'workspace_created',
  'user_signed_up',
] as const;

export type PostHogEventName = (typeof POSTHOG_EVENT_NAMES)[number];

/**
 * Maps the dotted event names already written to Postgres by
 * `AnalyticsService.recordEventInternal` onto PostHog names. Anything absent
 * from this map is intentionally not forwarded.
 */
export const INTERNAL_EVENT_TO_POSTHOG: ReadonlyMap<string, PostHogEventName> = new Map<
  string,
  PostHogEventName
>([
  ['call.started', 'call_started'],
  ['call.ended', 'call_ended'],
  ['call.blocked', 'call_blocked'],
  ['agent.created', 'agent_created'],
  ['agent.published', 'agent_published'],
  ['workspace.created', 'workspace_created'],
  ['user.signed_up', 'user_signed_up'],
]);

/**
 * A Map is used rather than a plain object so that inherited keys such as
 * `constructor` or `toString` cannot resolve to a truthy non-event value.
 */
export function mapInternalEventName(eventType: string): PostHogEventName | null {
  return INTERNAL_EVENT_TO_POSTHOG.get(eventType) ?? null;
}

// --- shared bounded primitives ------------------------------------------

const uuid = z.string().uuid();

/** Provider/plan style identifiers: lowercase slugs only, never free text. */
const slug = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_-]+$/, 'must be a lowercase slug');

const durationSeconds = z.number().int().min(0).max(86_400);

const versionNumber = z.number().int().min(0).max(1_000_000);

// --- per-event property schemas -----------------------------------------

const CallStartedPropertiesSchema = z.object({
  call_id: uuid.optional(),
  agent_id: uuid.optional(),
  direction: CallDirectionSchema,
  provider: slug.optional(),
});

const CallEndedPropertiesSchema = z.object({
  call_id: uuid.optional(),
  agent_id: uuid.optional(),
  direction: CallDirectionSchema,
  outcome: CallOutcomeSchema.optional(),
  duration_seconds: durationSeconds.optional(),
});

const CallBlockedPropertiesSchema = z.object({
  agent_id: uuid.optional(),
  direction: CallDirectionSchema.default('outbound'),
  reason_codes: z.array(ComplianceReasonCodeSchema).max(10),
});

const AgentCreatedPropertiesSchema = z.object({
  agent_id: uuid,
  template_id: slug.optional(),
});

const AgentPublishedPropertiesSchema = z.object({
  agent_id: uuid,
  agent_version_id: uuid.optional(),
  version_number: versionNumber.optional(),
});

const WorkspaceCreatedPropertiesSchema = z.object({
  workspace_id: uuid,
});

const UserSignedUpPropertiesSchema = z.object({
  workspace_id: uuid.optional(),
});

const EVENT_PROPERTY_SCHEMAS = {
  call_started: CallStartedPropertiesSchema,
  call_ended: CallEndedPropertiesSchema,
  call_blocked: CallBlockedPropertiesSchema,
  agent_created: AgentCreatedPropertiesSchema,
  agent_published: AgentPublishedPropertiesSchema,
  workspace_created: WorkspaceCreatedPropertiesSchema,
  user_signed_up: UserSignedUpPropertiesSchema,
} as const satisfies Record<PostHogEventName, z.ZodTypeAny>;

export type PostHogEventProperties = {
  [K in PostHogEventName]: z.infer<(typeof EVENT_PROPERTY_SCHEMAS)[K]>;
};

export function isPostHogEventName(value: string): value is PostHogEventName {
  return (POSTHOG_EVENT_NAMES as readonly string[]).includes(value);
}

// --- identity policy ----------------------------------------------------

export type PostHogIdentityKind = 'user' | 'non_person';

export interface PostHogIdentity {
  distinctId: string;
  /** Passed through as `$process_person_profile`. */
  processPersonProfile: boolean;
}

/**
 * Which identity an event is allowed to use. Call lifecycle events are
 * autonomous: they have no acting user, so they must not create person
 * profiles.
 */
export const EVENT_IDENTITY_KIND: Readonly<Record<PostHogEventName, PostHogIdentityKind>> =
  Object.freeze({
    call_started: 'non_person',
    call_ended: 'non_person',
    call_blocked: 'non_person',
    agent_created: 'user',
    agent_published: 'user',
    workspace_created: 'user',
    user_signed_up: 'user',
  });

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * App user IDs come from the auth provider and are not necessarily UUIDs, so
 * they are validated for shape rather than format: non-empty, bounded, opaque,
 * and never PII-shaped. A value that looks like a phone number or email is
 * rejected outright so it can never become a person distinct ID.
 */
export function userIdentity(userId: string): PostHogIdentity | null {
  if (typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (trimmed.includes('@') || isUnsafeString(trimmed)) return null;
  return { distinctId: trimmed, processPersonProfile: true };
}

/**
 * Opaque non-person identity for autonomous events.
 *
 * There is deliberately no workspace-wide fallback bucket: a stable
 * `workspace:<id>` distinct ID would collapse every autonomous event in a
 * tenant into one synthetic cross-call entity, merging unrelated call journeys
 * and — if a caller ever dropped `$process_person_profile: false` — creating a
 * workspace-shaped person. Callers that have no call ID yet (pre-call compliance
 * blocks) must pass another opaque per-event ID such as the compliance check ID.
 * Tenant aggregation is the job of `$groups.workspace`, not the distinct ID.
 */
export function nonPersonIdentity(seed: { eventScopeId: string }): PostHogIdentity | null {
  const id = typeof seed.eventScopeId === 'string' ? seed.eventScopeId.trim() : '';
  if (!UUID_SHAPE.test(id)) return null;
  return { distinctId: `call:${id}`, processPersonProfile: false };
}

// --- group policy -------------------------------------------------------

export interface PostHogGroupInput {
  workspaceId: string;
  organizationId?: string | null;
}

/**
 * Both IDs must be trusted values resolved server-side. Returns null when the
 * workspace ID is not a well-formed opaque ID, so a malformed or attacker-
 * influenced value can never attribute an event to a tenant.
 */
export function buildGroups(input: PostHogGroupInput): Record<string, string> | null {
  if (!UUID_SHAPE.test(input.workspaceId ?? '')) return null;
  const groups: Record<string, string> = { workspace: input.workspaceId };
  if (input.organizationId) {
    if (!UUID_SHAPE.test(input.organizationId)) return null;
    groups.organization = input.organizationId;
  }
  return groups;
}

// --- defense-in-depth PII scan ------------------------------------------

/**
 * Key names that must never appear in a PostHog payload. This list exists to
 * catch programming mistakes; it is deliberately NOT the mechanism that keeps
 * PII out (the per-event schemas are).
 */
export const FORBIDDEN_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'address',
  'api_key',
  'apikey',
  'arguments',
  'authorization',
  'body',
  'contact_name',
  'content',
  'credential',
  'email',
  'from_number',
  'full_name',
  'headers',
  'knowledge',
  'message',
  'metadata',
  'name',
  'password',
  'payload',
  'phone',
  'phone_number',
  'prompt',
  'query',
  'recording_url',
  'secret',
  'spec',
  'spec_json',
  'system_prompt',
  'text',
  'to_number',
  'token',
  'transcript',
  'transcript_text',
  'url',
]);

const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_LIKE_RE = /\+?\d[\d\s().-]{6,}\d/;

function isUnsafeString(value: string): boolean {
  if (value.length > MAX_STRING_LENGTH) return true;
  if (UUID_RE.test(value)) return false;
  return PHONE_LIKE_RE.test(value);
}

/**
 * Recursively checks a value for forbidden keys, phone-like strings and
 * unbounded text. Returns true when the value must not be sent.
 */
export function containsUnsafeValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (value === null || value === undefined) return false;

  const type = typeof value;
  if (type === 'string') return isUnsafeString(value as string);
  if (type === 'number') return !Number.isFinite(value);
  if (type === 'boolean') return false;

  if (Array.isArray(value)) {
    return value.some((item) => containsUnsafeValue(item, depth + 1));
  }

  if (type === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PROPERTY_KEYS.has(key.toLowerCase())) return true;
      if (containsUnsafeValue(nested, depth + 1)) return true;
    }
    return false;
  }

  // functions, symbols, bigint and anything else are never serializable safely
  return true;
}

// --- builder ------------------------------------------------------------

export interface SanitizedPostHogEvent {
  event: PostHogEventName;
  properties: Record<string, unknown>;
}

/**
 * Validates and sanitizes a candidate event.
 *
 * Accepts either a PostHog event name or an internal dotted name. Returns
 * `null` — meaning "drop silently" — when the event is unknown, its properties
 * fail validation, or the sanitized result still trips the PII scan. Never
 * mutates `input.properties`.
 */
export function buildPostHogEvent(input: {
  event: string;
  properties?: Record<string, unknown> | null;
}): SanitizedPostHogEvent | null {
  // Total by construction. A hostile or provider-derived payload can carry a
  // throwing getter or a proxy, and analytics must never raise into the call
  // path, so any failure here degrades to "drop the event".
  try {
    return buildPostHogEventUnsafe(input);
  } catch {
    return null;
  }
}

function buildPostHogEventUnsafe(input: {
  event: string;
  properties?: Record<string, unknown> | null;
}): SanitizedPostHogEvent | null {
  const event = isPostHogEventName(input.event)
    ? input.event
    : mapInternalEventName(input.event);
  if (!event) return null;

  const candidate = normalizeProperties(event, toPlainRecord(input.properties));
  const parsed = EVENT_PROPERTY_SCHEMAS[event].safeParse(candidate);
  if (!parsed.success) return null;

  const properties = dropNullish(parsed.data as Record<string, unknown>);
  if (containsUnsafeValue(properties)) return null;

  return { event, properties };
}

/**
 * Copies own enumerable data properties into a plain object, skipping accessors
 * entirely. Reading a getter can execute arbitrary caller code (or throw), and
 * a proxy can lie about its own keys, so neither is ever invoked here.
 */
function toPlainRecord(input?: Record<string, unknown> | null): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return output;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) continue; // accessor: never read
    const { value } = descriptor;
    if (value !== null && value !== undefined) output[key] = value;
  }
  return output;
}

/**
 * Maps known internal payload shapes onto contract fields before validation.
 *
 * `calls.service.ts` emits compliance failures as `reasons: [{ code, message }]`
 * where `message` is operator-facing free text that can embed the dialled
 * number. Only the enum codes are lifted across; the messages are discarded.
 * A malformed `reasons` value is left unmapped so the schema rejects the event
 * rather than silently reporting zero reasons.
 */
function normalizeProperties(
  event: PostHogEventName,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  if (event !== 'call_blocked') return properties;
  if ('reason_codes' in properties) return properties;

  const { reasons, ...rest } = properties;
  if (reasons === undefined) return { ...rest, reason_codes: [] };
  if (!Array.isArray(reasons)) return rest; // malformed: fail validation

  const codes = reasons.map((reason) =>
    reason !== null && typeof reason === 'object' && !Array.isArray(reason)
      ? (reason as Record<string, unknown>).code
      : reason,
  );
  return { ...rest, reason_codes: codes };
}

/**
 * Copies an object without null/undefined values. Postgres-backed payloads use
 * `null` for absent columns (for example `outcome`), which would otherwise fail
 * `.optional()` fields, and null properties add no analytical value.
 */
function dropNullish(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) output[key] = value;
  }
  return output;
}

// --- atomic capture construction ----------------------------------------

export interface PostHogCapture {
  event: PostHogEventName;
  distinctId: string;
  properties: Record<string, unknown>;
  groups: Record<string, string>;
  processPersonProfile: boolean;
}

export interface PostHogCaptureContext {
  /** Trusted workspace ID resolved server-side. */
  workspaceId: string;
  /** Trusted organization ID resolved server-side; omit on the browser. */
  organizationId?: string | null;
  /** Authenticated app user ID. Required for `user` events. */
  userId?: string | null;
  /**
   * Opaque per-event scope ID for autonomous events — normally the call ID, or
   * the compliance check ID for a pre-call block. Required for `non_person`
   * events.
   */
  eventScopeId?: string | null;
}

/**
 * The only supported way to construct a capture.
 *
 * Identity is bound to the event here rather than chosen by the caller, so
 * `EVENT_IDENTITY_KIND` is enforced instead of advisory: a call lifecycle event
 * cannot be paired with a person identity, and a user event cannot be sent
 * without an authenticated user. Returns `null` to mean "drop" and never
 * throws, so no caller can turn an analytics problem into a product failure.
 */
export function buildPostHogCapture(input: {
  event: string;
  properties?: Record<string, unknown> | null;
  context: PostHogCaptureContext;
}): PostHogCapture | null {
  try {
    const sanitized = buildPostHogEventUnsafe(input);
    if (!sanitized) return null;

    const groups = buildGroups({
      workspaceId: input.context.workspaceId,
      organizationId: input.context.organizationId,
    });
    if (!groups) return null;

    const identity =
      EVENT_IDENTITY_KIND[sanitized.event] === 'user'
        ? userIdentity(input.context.userId ?? '')
        : nonPersonIdentity({ eventScopeId: input.context.eventScopeId ?? '' });
    if (!identity) return null;

    return {
      event: sanitized.event,
      distinctId: identity.distinctId,
      properties: sanitized.properties,
      groups,
      processPersonProfile: identity.processPersonProfile,
    };
  } catch {
    return null;
  }
}
