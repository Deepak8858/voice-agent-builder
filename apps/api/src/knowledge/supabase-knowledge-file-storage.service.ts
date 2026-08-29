import { Injectable, Logger } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { KnowledgeIngestFailedError } from '../common/errors';
import { env } from '../config/env';
import type {
  KnowledgeFileStorage,
  SaveKnowledgeFileInput,
  StoredKnowledgeFile,
} from './knowledge-file-storage.interface';

const DEFAULT_BUCKET = 'knowledge-files';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/x-pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/vnd.ms-excel',
  'application/json',
];

@Injectable()
export class SupabaseKnowledgeFileStorage implements KnowledgeFileStorage {
  private readonly logger = new Logger(SupabaseKnowledgeFileStorage.name);
  private readonly client: SupabaseClient | null;
  private readonly bucket: string;
  private bucketReady = false;

  constructor() {
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    this.bucket = env.SUPABASE_KNOWLEDGE_BUCKET ?? env.SUPABASE_STORAGE_BUCKET ?? DEFAULT_BUCKET;
    this.client = serviceRoleKey
      ? createClient(env.SUPABASE_URL, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: WebSocket as never },
      })
      : null;
  }

  async saveUploadedFile(input: SaveKnowledgeFileInput): Promise<StoredKnowledgeFile> {
    const client = this.requireClient();
    await this.ensureBucket(client);

    const path = buildKnowledgeStoragePath({
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      agentId: input.agentId,
      filename: input.filename,
    });

    const { data, error } = await client.storage.from(this.bucket).upload(path, input.buffer, {
      contentType: input.mimeType ?? 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    });

    if (error) {
      throw new KnowledgeIngestFailedError(`Supabase file upload failed: ${error.message}`, {
        provider: 'supabase',
        bucket: this.bucket,
        path,
      });
    }

    const bucket = this.bucket;
    const storedPath = data?.path ?? path;
    return {
      provider: 'supabase',
      bucket,
      path: storedPath,
      fileUrl: `supabase://${bucket}/${storedPath}`,
      publicUrl: null,
    };
  }

  async deleteStoredFile(file: StoredKnowledgeFile): Promise<void> {
    if (file.provider !== 'supabase') return;
    const client = this.client;
    if (!client) return;
    const { error } = await client.storage.from(file.bucket).remove([file.path]);
    if (error) {
      this.logger.warn(`Failed to delete Supabase object ${file.bucket}/${file.path}: ${error.message}`);
    }
  }

  private requireClient(): SupabaseClient {
    if (!this.client) {
      throw new KnowledgeIngestFailedError(
        'Supabase Storage is not configured. Set SUPABASE_SERVICE_ROLE_KEY.',
        {
          provider: 'supabase',
          missing: { SUPABASE_SERVICE_ROLE_KEY: !env.SUPABASE_SERVICE_ROLE_KEY },
        },
      );
    }
    return this.client;
  }

  private async ensureBucket(client: SupabaseClient): Promise<void> {
    if (this.bucketReady) return;

    const existing = await client.storage.getBucket(this.bucket);
    if (!existing.error && existing.data) {
      this.bucketReady = true;
      return;
    }

    const created = await client.storage.createBucket(this.bucket, {
      public: false,
      allowedMimeTypes: ALLOWED_MIME_TYPES,
      fileSizeLimit: MAX_FILE_BYTES,
    });

    if (created.error) {
      const retry = await client.storage.getBucket(this.bucket);
      if (retry.error || !retry.data) {
        throw new KnowledgeIngestFailedError(`Supabase bucket setup failed: ${created.error.message}`, {
          provider: 'supabase',
          bucket: this.bucket,
        });
      }
    }

    this.bucketReady = true;
  }
}

export function buildKnowledgeStoragePath(input: {
  workspaceId: string;
  organizationId: string;
  agentId?: string | null;
  filename?: string | null;
}): string {
  const safeName = sanitizeStorageFilename(input.filename);
  const ownerScope = input.agentId ? `agents/${input.agentId}` : 'workspace';
  return [
    'organizations',
    input.organizationId,
    'workspaces',
    input.workspaceId,
    ownerScope,
    `${randomUUID()}-${safeName}`,
  ].join('/');
}

export function sanitizeStorageFilename(filename?: string | null): string {
  const rawName = filename?.split(/[\\/]/).pop()?.trim() || 'upload.txt';
  const safe = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  const trimmed = safe.slice(0, 180).replace(/^[._-]+/, '').replace(/[._-]+$/, '');
  return trimmed || 'upload.txt';
}
