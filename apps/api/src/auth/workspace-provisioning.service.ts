import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WorkspaceProvisioningService {
  private readonly logger = new Logger(WorkspaceProvisioningService.name);

  orgSlug(clerkOrgId: string): string {
    return `clerk-${clerkOrgId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 32)}`;
  }

  async resolveOrgName(clerkOrgId: string, fallback: string): Promise<string> {
    return fallback;
  }
}