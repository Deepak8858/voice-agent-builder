import { Logger, Module, type Provider } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { env } from '../config/env';
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from './embeddings/embedding.provider.interface';
import { OpenAIEmbeddingAdapter } from './embeddings/openai.embedding.adapter';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { FileParser } from './parsers/file-parser';

const embeddingProvider: Provider = {
  provide: EMBEDDING_PROVIDER_TOKEN,
  useFactory: (): EmbeddingProvider => {
    const logger = new Logger('KnowledgeModule');
    if (env.EMBEDDING_PROVIDER === 'openai') {
      if (!env.OPENAI_API_KEY) {
        throw new Error('EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set.');
      }
      return new OpenAIEmbeddingAdapter();
    }
    throw new Error(`Unsupported EMBEDDING_PROVIDER: ${env.EMBEDDING_PROVIDER}`);
  },
};

@Module({
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    WorkspaceGuard,
    FileParser,
    embeddingProvider,
  ],
  exports: [KnowledgeService, EMBEDDING_PROVIDER_TOKEN],
})
export class KnowledgeModule {}
