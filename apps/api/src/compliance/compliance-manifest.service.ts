import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import { env } from '../config/env';

interface ComplianceManifest {
  generatedAt: string;
  version: string;
  encryption: {
    atRest: boolean;
    inTransit: boolean;
    keyConfigured: boolean;
  };
  dataRetention: {
    defaultDays: number;
    configurablePerWorkspace: boolean;
    enforcement: 'ttl_column + cron_sweep';
  };
  auditLogging: {
    enabled: boolean;
    eventsTracked: string[];
    exportFormats: string[];
  };
  dataResidency: {
    primaryRegion: string;
    backups: string;
  };
  subprocessors: Array<{ name: string; purpose: string; dataTypes: string[] }>;
  signature: string;
}

@Injectable()
export class ComplianceManifestService {
  private readonly HMAC_SECRET = env.ENCRYPTION_KEY ?? 'manifest-secret';

  async generate(): Promise<ComplianceManifest> {
    const manifest: Omit<ComplianceManifest, 'signature'> = {
      generatedAt: new Date().toISOString(),
      version: '1.0',
      encryption: {
        atRest: true,
        inTransit: true,
        keyConfigured: !!env.ENCRYPTION_KEY,
      },
      dataRetention: {
        defaultDays: 365,
        configurablePerWorkspace: true,
        enforcement: 'ttl_column + cron_sweep',
      },
      auditLogging: {
        enabled: true,
        eventsTracked: [
          'call.started', 'call.ended', 'call.blocked',
          'agent.created', 'agent.updated', 'agent.deleted',
          'gdpr.contact.erased', 'gdpr.organization_deleted', 'gdpr.user_deleted',
          'compliance.manifest_generated',
        ],
        exportFormats: ['csv', 'json', 'signed_url'],
      },
      dataResidency: {
        primaryRegion: 'us-east-1',
        backups: 'Supabase automated backups + pg_cron snapshots',
      },
      subprocessors: [
        { name: 'Vapi', purpose: 'Voice telephony', dataTypes: ['audio', 'transcripts'] },
        { name: 'Twilio', purpose: 'Voice telephony', dataTypes: ['audio', 'call metadata'] },
        { name: 'Supabase', purpose: 'Database + Auth', dataTypes: ['user data', 'call records'] },
        { name: 'Deepgram', purpose: 'Speech-to-text', dataTypes: ['audio'] },
        { name: 'Resend', purpose: 'Transactional email', dataTypes: ['email addresses'] },
      ],
    };

    const content = JSON.stringify(manifest);
    const signature = createHmac('sha256', this.HMAC_SECRET).update(content).digest('hex');

    return { ...manifest, signature };
  }
}
