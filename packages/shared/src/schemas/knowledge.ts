import { z } from 'zod';

export const KnowledgeSourceTypeSchema = z.enum(['url', 'text', 'file']);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeSchema>;

export const KnowledgeSourceStatusSchema = z.enum(['pending', 'processing', 'ready', 'failed']);
export type KnowledgeSourceStatus = z.infer<typeof KnowledgeSourceStatusSchema>;

export const CreateKnowledgeSourceDtoSchema = z
  .object({
    title: z.string().min(1).max(200),
    source_type: KnowledgeSourceTypeSchema,
    agent_id: z.string().uuid().nullable().optional(),
    file_url: z.string().url().optional(),
    content: z.string().max(200_000).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.source_type === 'text' && (!v.content || v.content.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'content is required for source_type="text".',
      });
    }
    if ((v.source_type === 'url' || v.source_type === 'file') && !v.file_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['file_url'],
        message: 'file_url is required for source_type="url" or "file".',
      });
    }
  });
export type CreateKnowledgeSourceDto = z.infer<typeof CreateKnowledgeSourceDtoSchema>;

export const UpdateKnowledgeSourceDtoSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  agent_id: z.string().uuid().nullable().optional(),
  status: KnowledgeSourceStatusSchema.optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type UpdateKnowledgeSourceDto = z.infer<typeof UpdateKnowledgeSourceDtoSchema>;

export const KnowledgeSourceSummarySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  agent_id: z.string().uuid().nullable(),
  title: z.string(),
  source_type: KnowledgeSourceTypeSchema,
  status: KnowledgeSourceStatusSchema,
  file_url: z.string().nullable(),
  chunk_count: z.number().int().min(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type KnowledgeSourceSummary = z.infer<typeof KnowledgeSourceSummarySchema>;

export const KnowledgeSourceListQuerySchema = z.object({
  agent_id: z.string().uuid().optional(),
  scope: z.enum(['all', 'workspace', 'agent']).default('all').optional(),
});
export type KnowledgeSourceListQuery = z.infer<typeof KnowledgeSourceListQuerySchema>;

export const KnowledgeSearchQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  agent_id: z.string().uuid().nullable().optional(),
  k: z.coerce.number().int().min(1).max(20).default(5).optional(),
});
export type KnowledgeSearchQuery = z.infer<typeof KnowledgeSearchQuerySchema>;

export const KnowledgeSearchHitSchema = z.object({
  chunk_id: z.string().uuid(),
  source_id: z.string().uuid(),
  source_title: z.string(),
  source_type: KnowledgeSourceTypeSchema,
  agent_id: z.string().uuid().nullable(),
  chunk_index: z.number().int().min(0),
  content: z.string(),
  score: z.number(),
});
export type KnowledgeSearchHit = z.infer<typeof KnowledgeSearchHitSchema>;

export const KnowledgeSearchResultSchema = z.object({
  query: z.string(),
  hits: z.array(KnowledgeSearchHitSchema),
});
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResultSchema>;

export const KnowledgeFileTypeSchema = z.enum(['pdf', 'csv', 'txt']);
export type KnowledgeFileType = z.infer<typeof KnowledgeFileTypeSchema>;

export const KnowledgeUploadFormSchema = z.object({
  title: z.string().min(1).max(200),
  agent_id: z.string().uuid().nullable().optional(),
});
export type KnowledgeUploadForm = z.infer<typeof KnowledgeUploadFormSchema>;
