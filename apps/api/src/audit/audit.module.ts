import { Global, Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, WorkspaceGuard],
  exports: [AuditService],
})
export class AuditModule {}
