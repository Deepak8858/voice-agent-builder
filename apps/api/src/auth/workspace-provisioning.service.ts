import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WorkspaceProvisioningService {
  private readonly logger = new Logger(WorkspaceProvisioningService.name);

  orgSlug(supabaseUserId: string): string {
    return `user-${supabaseUserId.slice(0, 8)}`;
  }
}