import { Module } from '@nestjs/common';
import { GoogleConnectionModule } from '../google-connection/google-connection.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { AgentSheetService } from './agent-sheet.service';
import { AgentSheetsInternalController } from './agent-sheets-internal.controller';

// No cycle: GoogleConnectionModule, PrismaModule and QueueModule import nothing
// that imports this module. AgentsModule (publish) and TelephonyModule (call
// end) import it.
@Module({
  imports: [PrismaModule, GoogleConnectionModule, QueueModule],
  controllers: [AgentSheetsInternalController],
  providers: [AgentSheetService],
  exports: [AgentSheetService],
})
export class AgentSheetsModule {}
