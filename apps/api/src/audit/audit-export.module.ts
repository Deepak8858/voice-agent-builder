import { Module } from '@nestjs/common';
import { AuditExportService } from './audit-export.service';
import { AuditExportController } from './audit-export.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [AuditExportController],
  providers: [AuditExportService],
  exports: [AuditExportService],
})
export class AuditExportModule {}