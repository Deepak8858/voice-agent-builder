/**
 * Minimal JSON-Schema input validator. Supports the subset our AgentTool spec
 * uses: `type=object` with `properties` and `required`. Each property may
 * declare `type` ∈ {string, number, integer, boolean, array, object} and
 * `enum`. Anything else is treated as "any".
 *
 * We deliberately avoid bringing in Ajv or another dependency — agent-built
 * tools don't need full Draft-2020 semantics.
 */

interface JsonSchema {
  type: 'object';
  properties?: Record<string, PropSchema>;
  required?: string[];
  [key: string]: unknown;
}

interface PropSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  enum?: unknown[];
  [key: string]: unknown;
}

export interface InputValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateToolInput(
  schema: JsonSchema,
  args: Record<string, unknown>,
): InputValidationResult {
  const errors: string[] = [];
  const required = schema.required ?? [];
  for (const k of required) {
    if (!(k in args)) errors.push(`missing required field: ${k}`);
  }

  const props = schema.properties ?? {};
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) continue;
    if (p.enum && !p.enum.includes(v)) {
      errors.push(`field ${k} must be one of ${JSON.stringify(p.enum)}`);
      continue;
    }
    if (!p.type) continue;
    const ok =
      (p.type === 'string' && typeof v === 'string') ||
      (p.type === 'number' && typeof v === 'number') ||
      (p.type === 'integer' && Number.isInteger(v)) ||
      (p.type === 'boolean' && typeof v === 'boolean') ||
      (p.type === 'array' && Array.isArray(v)) ||
      (p.type === 'object' && v !== null && typeof v === 'object' && !Array.isArray(v));
    if (!ok) errors.push(`field ${k} must be of type ${p.type}`);
  }
  return { valid: errors.length === 0, errors };
}
