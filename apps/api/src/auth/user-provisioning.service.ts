import { Injectable, Logger } from '@nestjs/common';
import type { ClerkClient } from '@clerk/backend';

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  async provision(externalAuthId: string, clerkUserId: string): Promise<{ id: string; email: string; name: string | null }> {
    // Subclasses or consumers handle the actual Clerk user lookup
    // This service is for DB operations only
    return { id: externalAuthId, email: `${clerkUserId}@clerk.invalid`, name: null };
  }
}