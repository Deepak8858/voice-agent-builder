import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseHealthService } from './database-health.service';

@Module({
  controllers: [HealthController],
  providers: [DatabaseHealthService],
})
export class HealthModule {}
