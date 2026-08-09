export interface SaveKnowledgeFileInput {
  workspaceId: string;
  organizationId: string;
  agentId?: string | null;
  buffer: Buffer;
  filename?: string | null;
  mimeType?: string | null;
}

export interface StoredKnowledgeFile {
  provider: 'supabase' | 's3';
  bucket: string;
  path: string;
  fileUrl: string;
  publicUrl?: string | null;
}

export interface KnowledgeFileStorage {
  saveUploadedFile(input: SaveKnowledgeFileInput): Promise<StoredKnowledgeFile>;
  deleteStoredFile(file: StoredKnowledgeFile): Promise<void>;
}

export const KNOWLEDGE_FILE_STORAGE_TOKEN = Symbol('KNOWLEDGE_FILE_STORAGE_TOKEN');
