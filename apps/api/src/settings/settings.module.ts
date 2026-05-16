import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { RetentionModule } from '../compliance/retention.module';

@Module({
  imports: [RetentionModule],
  controllers: [SettingsController],
})
export class SettingsModule {}