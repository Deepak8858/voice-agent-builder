import { Module, type Provider } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { env } from '../config/env';
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from './embeddings/embedding.provider.interface';
import { OpenAIEmbeddingAdapter } from './embeddings/openai.embedding.adapter';
import { KnowledgeController } from './knowledge.controller';
import {
  createKnowledgeFileStorage,
  type KnowledgeStorageProvider,
} from './knowledge-file-storage-router';
import {
  KNOWLEDGE_FILE_STORAGE_TOKEN,
  type KnowledgeFileStorage,
} from './knowledge-file-storage.interface';
import { KnowledgeService } from './knowledge.service';
import { FileParser } from './parsers/file-parser';
import { S3KnowledgeFileStorage } from './s3-knowledge-file-storage.service';
import { SupabaseKnowledgeFileStorage } from './supabase-knowledge-file-storage.service';

const embeddingProvider: Provider = {
  provide: EMBEDDING_PROVIDER_TOKEN,
  useFactory: (): EmbeddingProvider => {
    if (env.EMBEDDING_PROVIDER === 'openai') {
      if (!env.OPENAI_API_KEY) {
        throw new Error('EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set.');
      }
      return new OpenAIEmbeddingAdapter();
    }
    throw new Error(`Unsupported EMBEDDING_PROVIDER: ${env.EMBEDDING_PROVIDER}`);
  },
};

const knowledgeFileStorageProvider: Provider = {
  provide: KNOWLEDGE_FILE_STORAGE_TOKEN,
  inject: [SupabaseKnowledgeFileStorage, S3KnowledgeFileStorage],
  useFactory: (
    supabase: SupabaseKnowledgeFileStorage,
    s3: S3KnowledgeFileStorage,
  ): KnowledgeFileStorage => createKnowledgeFileStorage(
    env.KNOWLEDGE_STORAGE_PROVIDER as KnowledgeStorageProvider,
    supabase,
    s3,
  ),
};

@Module({
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    WorkspaceGuard,
    FileParser,
    SupabaseKnowledgeFileStorage,
    S3KnowledgeFileStorage,
    knowledgeFileStorageProvider,
    embeddingProvider,
  ],
  exports: [KnowledgeService, EMBEDDING_PROVIDER_TOKEN],
})
export class KnowledgeModule {}
