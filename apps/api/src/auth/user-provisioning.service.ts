import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  async provision(externalAuthId: string): Promise<{ id: string; email: string; name: string | null }> {
    return { id: externalAuthId, email: `${externalAuthId}@supabase.invalid`, name: null };
  }
}