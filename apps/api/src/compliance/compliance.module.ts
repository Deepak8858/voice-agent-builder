import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ContactsController } from './contacts.controller';
import { ErasureController } from './erasure.controller';
import { ErasureService } from './erasure.service';

@Module({
  controllers: [ContactsController, ComplianceController, ErasureController],
  providers: [ComplianceService, ErasureService, WorkspaceGuard],
  exports: [ComplianceService, ErasureService],
})
export class ComplianceModule {}
