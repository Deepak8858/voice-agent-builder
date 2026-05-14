import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ContactsController } from './contacts.controller';
import { ErasureController } from './erasure.controller';
import { ErasureService } from './erasure.service';
import { ComplianceManifestController } from './compliance-manifest.controller';
import { ComplianceManifestService } from './compliance-manifest.service';
import { EmailModule } from '../email/email.module';

@Module({
  controllers: [ContactsController, ComplianceController, ErasureController, ComplianceManifestController],
  providers: [ComplianceService, ErasureService, ComplianceManifestService, WorkspaceGuard],
  exports: [ComplianceService, ErasureService],
  imports: [EmailModule],
})
export class ComplianceModule {}
