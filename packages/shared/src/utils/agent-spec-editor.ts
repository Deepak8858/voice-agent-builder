import type { z } from 'zod';

export function setAgentSpecPath(
  spec: unknown,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const next = cloneRecord(spec);
  const parts = path.split('.').filter(Boolean);
  let current = next;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const child = current[key];
    current[key] = isRecord(child) ? { ...child } : {};
    current = current[key] as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  if (leaf) current[leaf] = value;

  return next;
}

export function summarizeAgentSpecIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'spec';
    return `${path}: ${issue.message}`;
  });
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (typeof structuredClone === 'function') {
    return structuredClone(value) as Record<string, unknown>;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
