import { Module } from '@nestjs/common';
import { AuditExportService } from './audit-export.service';
import { AuditExportController } from './audit-export.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { OrganizationGuard } from '../common/organization.guard';

@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [AuditExportController],
  // OrganizationGuard is referenced by @UseGuards on the controller, so Nest
  // needs it instantiable in this module's injector. PrismaModule and
  // CacheModule are both @Global, so its own dependencies resolve.
  providers: [AuditExportService, OrganizationGuard],
  exports: [AuditExportService],
})
export class AuditExportModule {}
