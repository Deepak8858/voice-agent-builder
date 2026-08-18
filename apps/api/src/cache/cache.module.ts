import { Global, Module } from '@nestjs/common';
import { CacheInvalidator } from '../common/cache-invalidator';
import { CacheService } from './cache.service';
import { ResponseCacheService } from './response-cache.service';

@Global()
@Module({
  providers: [CacheService, CacheInvalidator, ResponseCacheService],
  exports: [CacheService, CacheInvalidator, ResponseCacheService],
})
export class CacheModule {}
