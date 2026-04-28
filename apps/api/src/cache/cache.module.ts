import { Global, Module } from '@nestjs/common';
import { CacheInvalidator } from '../common/cache-invalidator';
import { CacheService } from './cache.service';

@Global()
@Module({
  providers: [CacheService, CacheInvalidator],
  exports: [CacheService, CacheInvalidator],
})
export class CacheModule {}
