import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { WorkspaceGuard } from '../common/workspace.guard';
import { GoogleConnectionModule } from '../google-connection/google-connection.module';
import { ToolsController } from './tools.controller';
import { LiveKitToolsController } from './livekit-tools.controller';
import { ToolsService } from './tools.service';
import { WebhookExecutor } from './webhook-executor';
import { CrmExecutor } from './crm-executor';
import { GoogleCalendarExecutor } from './executors/google-calendar.executor';
import { GmailExecutor } from './executors/gmail.executor';
import { SheetsExecutor } from './executors/sheets.executor';

@Module({
  imports: [BillingModule, GoogleConnectionModule],
  controllers: [ToolsController, LiveKitToolsController],
  providers: [
    ToolsService,
    WebhookExecutor,
    CrmExecutor,
    GoogleCalendarExecutor,
    GmailExecutor,
    SheetsExecutor,
    WorkspaceGuard,
  ],
  exports: [ToolsService, CrmExecutor],
})
export class ToolsModule {}
