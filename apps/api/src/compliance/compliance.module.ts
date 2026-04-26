import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ContactsController } from './contacts.controller';

@Module({
  controllers: [ContactsController, ComplianceController],
  providers: [ComplianceService, WorkspaceGuard],
  exports: [ComplianceService],
})
export class ComplianceModule {}
