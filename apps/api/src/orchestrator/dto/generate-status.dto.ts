import { z } from 'zod';

export const GenerationStatusSchema = z.object({
  agent_id: z.string().uuid(),
  status: z.enum([
    'draft',
    'draft_generating',
    'draft_docs_ready',
    'draft_crm_ready',
    'publishing',
    'published',
    'failed',
  ]),
  steps: z.object({
    spec_generation: z.object({
      status: z.enum(['pending', 'done', 'failed']),
      error: z.string().optional()
    }),
    doc_ingest: z.object({
      status: z.enum(['pending', 'processing', 'done', 'failed']),
      progress: z.number(),
      total: z.number(),
      error: z.string().optional()
    }),
    crm_setup: z.object({
      status: z.enum(['pending', 'done', 'failed']),
      providers: z.array(z.string()),
      error: z.string().optional()
    }),
    phone_number: z.object({
      status: z.enum(['pending', 'done', 'skipped', 'failed']),
      number: z.string().optional(),
      error: z.string().optional()
    }),
    publish: z.object({
      status: z.enum(['pending', 'done', 'failed']),
      error: z.string().optional()
    }),
  }),
  agent_preview: z.any().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;
