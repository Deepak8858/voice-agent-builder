import type {
  KnowledgeFileStorage,
  SaveKnowledgeFileInput,
  StoredKnowledgeFile,
} from './knowledge-file-storage.interface';

export type KnowledgeStorageProvider = StoredKnowledgeFile['provider'];

class KnowledgeFileStorageRouter implements KnowledgeFileStorage {
  constructor(
    private readonly selectedProvider: KnowledgeStorageProvider,
    private readonly supabase: KnowledgeFileStorage,
    private readonly s3: KnowledgeFileStorage,
  ) {}

  saveUploadedFile(input: SaveKnowledgeFileInput): Promise<StoredKnowledgeFile> {
    return this.adapterFor(this.selectedProvider).saveUploadedFile(input);
  }

  deleteStoredFile(file: StoredKnowledgeFile): Promise<void> {
    return this.adapterFor(file.provider).deleteStoredFile(file);
  }

  private adapterFor(provider: KnowledgeStorageProvider): KnowledgeFileStorage {
    return provider === 's3' ? this.s3 : this.supabase;
  }
}

export function createKnowledgeFileStorage(
  provider: KnowledgeStorageProvider | undefined,
  supabase: KnowledgeFileStorage,
  s3: KnowledgeFileStorage,
): KnowledgeFileStorage {
  return new KnowledgeFileStorageRouter(provider ?? 'supabase', supabase, s3);
}
