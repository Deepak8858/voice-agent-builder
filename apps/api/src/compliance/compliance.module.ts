import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ContactsController } from './contacts.controller';
import { ErasureController } from './erasure.controller';
import { ErasureService } from './erasure.service';
import { ComplianceManifestController } from './compliance-manifest.controller';
import { ComplianceManifestService } from './compliance-manifest.service';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';
import { EmailModule } from '../email/email.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  controllers: [ContactsController, ComplianceController, ErasureController, ComplianceManifestController, RetentionController],
  providers: [ComplianceService, ErasureService, ComplianceManifestService, RetentionService, WorkspaceGuard],
  exports: [ComplianceService, ErasureService, RetentionService],
  // KnowledgeModule supplies KNOWLEDGE_FILE_STORAGE_TOKEN so GDPR erasure can
  // delete the customer files behind knowledge sources, not just their rows.
  imports: [EmailModule, KnowledgeModule],
})
export class ComplianceModule {}

@Module({
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
