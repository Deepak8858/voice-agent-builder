import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [ComplianceModule],
  controllers: [SettingsController],
})
export class SettingsModule {}