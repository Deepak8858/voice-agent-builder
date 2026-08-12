import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeFileStorage } from './knowledge-file-storage-router';
import type { KnowledgeFileStorage, StoredKnowledgeFile } from './knowledge-file-storage.interface';
import { S3KnowledgeFileStorage } from './s3-knowledge-file-storage.service';

describe('S3KnowledgeFileStorage', () => {
  it('uploads to the existing organization/workspace/agent-scoped key layout', async () => {
    const sent: Array<PutObjectCommand | DeleteObjectCommand> = [];
    const client = { send: vi.fn(async (command: PutObjectCommand | DeleteObjectCommand) => {
      sent.push(command);
      return {};
    }) };
    const storage = new S3KnowledgeFileStorage(client, {
      region: 'us-east-1',
      bucket: 'private-knowledge',
      prefix: 'knowledge',
    });

    const stored = await storage.saveUploadedFile({
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      filename: '../FAQ copy.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('pdf'),
    });

    expect(client.send).toHaveBeenCalledOnce();
    const command = sent[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    if (!(command instanceof PutObjectCommand)) throw new Error('Expected PutObjectCommand');
    expect(command.input).toEqual(expect.objectContaining({
      Bucket: 'private-knowledge',
      Key: expect.stringMatching(
        /^knowledge\/organizations\/org-1\/workspaces\/workspace-1\/agents\/agent-1\/[0-9a-f-]+-FAQ_copy\.pdf$/,
      ),
      ContentType: 'application/pdf',
    }));
    expect(stored).toEqual(expect.objectContaining({
      provider: 's3',
      bucket: 'private-knowledge',
      path: command.input.Key,
      fileUrl: `s3://private-knowledge/${command.input.Key}`,
      publicUrl: null,
    }));
  });

  it('rejects files larger than 20 MB before calling S3', async () => {
    const client = { send: vi.fn(async () => ({})) };
    const storage = new S3KnowledgeFileStorage(client, { bucket: 'private-knowledge' });

    await expect(storage.saveUploadedFile({
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      filename: 'large.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
    })).rejects.toThrow('20 MB');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('rejects unsupported MIME types before calling S3', async () => {
    const client = { send: vi.fn(async () => ({})) };
    const storage = new S3KnowledgeFileStorage(client, { bucket: 'private-knowledge' });

    await expect(storage.saveUploadedFile({
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      filename: 'payload.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<html>'),
    })).rejects.toThrow('Unsupported file type');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('deletes S3 objects with the persisted bucket and key', async () => {
    const sent: Array<PutObjectCommand | DeleteObjectCommand> = [];
    const client = { send: vi.fn(async (command: PutObjectCommand | DeleteObjectCommand) => {
      sent.push(command);
      return {};
    }) };
    const storage = new S3KnowledgeFileStorage(client, { bucket: 'private-knowledge' });
    const file: StoredKnowledgeFile = {
      provider: 's3',
      bucket: 'legacy-bucket',
      path: 'organizations/org/workspaces/ws/workspace/file.txt',
      fileUrl: 's3://legacy-bucket/organizations/org/workspaces/ws/workspace/file.txt',
    };

    await storage.deleteStoredFile(file);

    const command = sent[0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    if (!(command instanceof DeleteObjectCommand)) throw new Error('Expected DeleteObjectCommand');
    expect(command.input).toEqual({ Bucket: file.bucket, Key: file.path });
  });
});

describe('createKnowledgeFileStorage', () => {
  const input = {
    organizationId: 'org-1',
    workspaceId: 'workspace-1',
    buffer: Buffer.from('text'),
    filename: 'faq.txt',
    mimeType: 'text/plain',
  };
  const supabaseFile: StoredKnowledgeFile = {
    provider: 'supabase',
    bucket: 'knowledge-files',
    path: 'supabase-path',
    fileUrl: 'supabase://knowledge-files/supabase-path',
  };
  const s3File: StoredKnowledgeFile = {
    provider: 's3',
    bucket: 'private-knowledge',
    path: 's3-path',
    fileUrl: 's3://private-knowledge/s3-path',
  };

  function adapter(file: StoredKnowledgeFile): KnowledgeFileStorage {
    return {
      saveUploadedFile: vi.fn(async () => file),
      deleteStoredFile: vi.fn(async () => undefined),
    };
  }

  it('defaults uploads to Supabase when provider is unset', async () => {
    const supabase = adapter(supabaseFile);
    const s3 = adapter(s3File);
    const storage = createKnowledgeFileStorage(undefined, supabase, s3);

    await expect(storage.saveUploadedFile(input)).resolves.toEqual(supabaseFile);
    expect(supabase.saveUploadedFile).toHaveBeenCalledWith(input);
    expect(s3.saveUploadedFile).not.toHaveBeenCalled();
  });

  it('dispatches deletion to each file persisted provider', async () => {
    const supabase = adapter(supabaseFile);
    const s3 = adapter(s3File);
    const storage = createKnowledgeFileStorage('s3', supabase, s3);

    await storage.deleteStoredFile(supabaseFile);
    await storage.deleteStoredFile(s3File);

    expect(supabase.deleteStoredFile).toHaveBeenCalledWith(supabaseFile);
    expect(s3.deleteStoredFile).toHaveBeenCalledWith(s3File);
  });
});
