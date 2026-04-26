import { Logger, Module, type Provider } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { env } from '../config/env';
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from './embeddings/embedding.provider.interface';
import { MockEmbeddingAdapter } from './embeddings/mock.embedding.adapter';
import { OpenAIEmbeddingAdapter } from './embeddings/openai.embedding.adapter';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { FileParser } from './parsers/file-parser';

const embeddingProvider: Provider = {
  provide: EMBEDDING_PROVIDER_TOKEN,
  inject: [MockEmbeddingAdapter],
  useFactory: (mock: MockEmbeddingAdapter): EmbeddingProvider => {
    const logger = new Logger('KnowledgeModule');
    if (env.EMBEDDING_PROVIDER === 'openai') {
      try {
        return new OpenAIEmbeddingAdapter();
      } catch (err) {
        logger.warn(
          `Falling back to mock embedder: ${(err as Error).message}`,
        );
        return mock;
      }
    }
    return mock;
  },
};

@Module({
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    WorkspaceGuard,
    FileParser,
    MockEmbeddingAdapter,
    embeddingProvider,
  ],
  exports: [KnowledgeService, EMBEDDING_PROVIDER_TOKEN],
})
export class KnowledgeModule {}
