import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const FlowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['start', 'speak', 'ask-question', 'condition', 'tool-call', 'transfer', 'end']),
  data: z.record(z.unknown()),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});

const FlowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  type: z.string().optional(),
});

const UpdateFlowDtoSchema = z.object({
  nodes: z.array(FlowNodeSchema),
  edges: z.array(FlowEdgeSchema),
});

describe('UpdateFlowDtoSchema validation', () => {
  it('should accept valid flow with nodes and edges', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [
        { id: '1', type: 'start', data: {} },
        { id: '2', type: 'speak', data: { message: 'Hello' } },
        { id: '3', type: 'end', data: {} },
      ],
      edges: [
        { id: 'e1', source: '1', target: '2' },
        { id: 'e2', source: '2', target: '3' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept flow node with position', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [
        { id: '1', type: 'start', data: {}, position: { x: 100, y: 200 } },
      ],
      edges: [],
    });
    expect(result.success).toBe(true);
  });

  it('should accept flow edge with optional fields', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [
        { id: '1', type: 'start', data: {} },
        { id: '2', type: 'end', data: {} },
      ],
      edges: [
        { id: 'e1', source: '1', target: '2', sourceHandle: 'output', targetHandle: 'input', type: 'default' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should reject flow with invalid node type', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [{ id: '1', type: 'invalid-type', data: {} }],
      edges: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('type');
    }
  });

  it('should reject flow with empty node id', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [{ id: '', type: 'start', data: {} }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  it('should reject flow with empty edge source', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [
        { id: '1', type: 'start', data: {} },
        { id: '2', type: 'end', data: {} },
      ],
      edges: [{ id: 'e1', source: '', target: '2' }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject flow with empty edge target', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [
        { id: '1', type: 'start', data: {} },
        { id: '2', type: 'end', data: {} },
      ],
      edges: [{ id: 'e1', source: '1', target: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject flow with missing nodes field', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  it('should reject flow with missing edges field', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [],
    });
    expect(result.success).toBe(false);
  });

  it('should reject node with invalid position type', () => {
    const result = UpdateFlowDtoSchema.safeParse({
      nodes: [
        { id: '1', type: 'start', data: {}, position: { x: '100', y: 200 } },
      ],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  it('should accept all valid node types', () => {
    const validTypes = ['start', 'speak', 'ask-question', 'condition', 'tool-call', 'transfer', 'end'];
    for (const type of validTypes) {
      const result = UpdateFlowDtoSchema.safeParse({
        nodes: [{ id: '1', type, data: {} }],
        edges: [],
      });
      expect(result.success).toBe(true);
    }
  });
});
