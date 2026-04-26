import { describe, expect, it } from 'vitest';
import { validateToolInput } from './input-validator';

const schema = {
  type: 'object' as const,
  properties: {
    name: { type: 'string' as const },
    age: { type: 'integer' as const },
    role: { type: 'string' as const, enum: ['admin', 'editor', 'viewer'] },
    tags: { type: 'array' as const },
    metadata: { type: 'object' as const },
    active: { type: 'boolean' as const },
  },
  required: ['name', 'role'],
};

describe('validateToolInput', () => {
  it('accepts a valid payload', () => {
    const r = validateToolInput(schema, {
      name: 'Ada',
      role: 'admin',
      age: 33,
      tags: ['a'],
      metadata: { x: 1 },
      active: true,
    });
    expect(r).toEqual({ valid: true, errors: [] });
  });

  it('flags missing required fields', () => {
    const r = validateToolInput(schema, { age: 1 });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('missing required field: name');
    expect(r.errors).toContain('missing required field: role');
  });

  it('flags type mismatches', () => {
    const r = validateToolInput(schema, {
      name: 123,
      role: 'admin',
      age: 'thirty',
      tags: 'oops',
      metadata: [],
      active: 'yes',
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        'field name must be of type string',
        'field age must be of type integer',
        'field tags must be of type array',
        'field metadata must be of type object',
        'field active must be of type boolean',
      ]),
    );
  });

  it('flags enum violations', () => {
    const r = validateToolInput(schema, { name: 'a', role: 'guest' });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('field role must be one of');
  });

  it('passes when only required fields supplied', () => {
    const r = validateToolInput(schema, { name: 'a', role: 'admin' });
    expect(r.valid).toBe(true);
  });

  it('integer rejects floats', () => {
    const r = validateToolInput(schema, { name: 'a', role: 'admin', age: 3.14 });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('field age must be of type integer');
  });

  it('ignores unknown fields without erroring', () => {
    const r = validateToolInput(schema, { name: 'a', role: 'admin', extra: 'ok' });
    expect(r.valid).toBe(true);
  });
});
