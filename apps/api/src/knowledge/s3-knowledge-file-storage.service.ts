import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeFileInvalidError, KnowledgeIngestFailedError } from '../common/errors';
import { env } from '../config/env';
import type {
  KnowledgeFileStorage,
  SaveKnowledgeFileInput,
  StoredKnowledgeFile,
} from './knowledge-file-storage.interface';
import { buildKnowledgeStoragePath } from './supabase-knowledge-file-storage.service';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/x-pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/vnd.ms-excel',
  'application/json',
]);

interface S3ClientLike {
  send(command: PutObjectCommand | DeleteObjectCommand): Promise<unknown>;
}

@Injectable()
export class S3KnowledgeFileStorage implements KnowledgeFileStorage {
  private readonly logger = new Logger(S3KnowledgeFileStorage.name);
  private readonly client: S3ClientLike;
  private readonly bucket: string | undefined;
  private readonly prefix: string;

  constructor(
    client?: S3ClientLike,
    config?: Pick<S3ClientConfig, 'region'> & { bucket?: string; prefix?: string },
  ) {
    this.bucket = config?.bucket ?? env.S3_KNOWLEDGE_BUCKET;
    this.prefix = config?.prefix ?? env.S3_KNOWLEDGE_PREFIX;
    this.client = client ?? new S3Client({ region: config?.region ?? env.AWS_REGION });
  }

  async saveUploadedFile(input: SaveKnowledgeFileInput): Promise<StoredKnowledgeFile> {
    const bucket = this.requireBucket();
    this.validateInput(input);
    const path = `${this.prefix}/${buildKnowledgeStoragePath({
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      agentId: input.agentId,
      filename: input.filename,
    })}`;

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: path,
        Body: input.buffer,
        ContentType: input.mimeType ?? 'application/octet-stream',
      }));
    } catch (error) {
      throw new KnowledgeIngestFailedError(`S3 file upload failed: ${this.errorMessage(error)}`, {
        provider: 's3',
        bucket,
        path,
      });
    }

    return {
      provider: 's3',
      bucket,
      path,
      fileUrl: `s3://${bucket}/${path}`,
      publicUrl: null,
    };
  }

  async deleteStoredFile(file: StoredKnowledgeFile): Promise<void> {
    if (file.provider !== 's3') return;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: file.bucket, Key: file.path }));
    } catch (error) {
      this.logger.warn(`Failed to delete S3 object ${file.bucket}/${file.path}: ${this.errorMessage(error)}`);
    }
  }

  private validateInput(input: SaveKnowledgeFileInput): void {
    if (input.buffer.length > MAX_FILE_BYTES) {
      throw new KnowledgeFileInvalidError('Knowledge file exceeds the 20 MB size limit.', {
        maxBytes: MAX_FILE_BYTES,
        actualBytes: input.buffer.length,
      });
    }
    if (!input.mimeType || !ALLOWED_MIME_TYPES.has(input.mimeType)) {
      throw new KnowledgeFileInvalidError(`Unsupported file type: ${input.mimeType ?? 'unknown'}`, {
        mimeType: input.mimeType ?? null,
      });
    }
  }

  private requireBucket(): string {
    if (!this.bucket) {
      throw new KnowledgeIngestFailedError(
        'S3 knowledge storage is not configured. Set S3_KNOWLEDGE_BUCKET.',
        { provider: 's3', missing: { S3_KNOWLEDGE_BUCKET: true } },
      );
    }
    return this.bucket;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
