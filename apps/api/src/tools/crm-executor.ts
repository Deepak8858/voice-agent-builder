import { Injectable } from '@nestjs/common';

export type CrmProvider = 'pipedrive' | 'hubspot' | 'salesforce' | 'generic';

export interface CrmConfig {
  api_key?: string;
  base_url?: string;
  object_type?: string;
}

export interface CrmContactArgs {
  full_name: string;
  phone?: string;
  email?: string;
  notes?: string;
  company?: string;
}

export interface CrmResult {
  contact_id: string;
  status: 'created' | 'updated';
  provider: CrmProvider;
}

/** Blocked IP ranges and hostnames that indicate internal/private resources. */
const BLOCKED_URL_PATTERNS = [
  /^127\./,
  /^localhost$/i,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^169\.254\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /\.internal$/i,
  /\.local$/i,
];

function isUrlBlocked(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return BLOCKED_URL_PATTERNS.some((re) => re.test(host));
  } catch {
    return true;
  }
}

@Injectable()
export class CrmExecutor {
  async createContact(
    provider: CrmProvider,
    config: CrmConfig,
    args: CrmContactArgs,
  ): Promise<CrmResult> {
    switch (provider) {
      case 'pipedrive':
        return this.pipedriveCreate(config, args);
      case 'hubspot':
        return this.hubspotCreate(config, args);
      case 'salesforce':
        return this.salesforceCreate(config, args);
      case 'generic':
        return this.genericCreate(config, args);
    }
  }

  private async pipedriveCreate(config: CrmConfig, args: CrmContactArgs): Promise<CrmResult> {
    const baseUrl = config.base_url ?? 'https://api.pipedrive.com/v1';
    const apiToken = config.api_key;

    if (!apiToken) throw new CrmAuthError('Pipedrive API key required');
    if (isUrlBlocked(baseUrl)) throw new CrmAuthError('CRM base_url resolves to a blocked address.');

    const nameParts = args.full_name.trim().split(/\s+/);
    const firstName = nameParts[0] ?? '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const phones = args.phone
      ? [{ value: args.phone, primary: true }]
      : undefined;

    const response = await this.httpPost(`${baseUrl}/persons?api_token=${apiToken}`, {
      name: args.full_name,
      first_name: firstName,
      last_name: lastName,
      phone: phones,
      org_name: args.company,
      notes: args.notes ? [{ content: args.notes }] : undefined,
    });

    const data = response as { data?: { id?: string | number } };
    if (!data?.data?.id) throw new CrmApiError('Pipedrive person creation failed', response);
    return {
      contact_id: String(data.data.id),
      status: 'created',
      provider: 'pipedrive',
    };
  }

  private async hubspotCreate(config: CrmConfig, args: CrmContactArgs): Promise<CrmResult> {
    const apiKey = config.api_key;
    if (!apiKey) throw new CrmAuthError('HubSpot API key required');

    const nameParts = args.full_name.trim().split(/\s+/);
    const firstName = nameParts[0] ?? '';
    const lastName = nameParts.slice(1).join(' ');

    const response = await this.httpPost(
      `https://api.hubapi.com/crm/v3/objects/contacts?hapikey=${apiKey}`,
      {
        properties: {
          firstname: firstName,
          lastname: lastName,
          phone: args.phone ?? '',
          email: args.email ?? '',
          company: args.company ?? '',
          notes_last_updated: args.notes ?? '',
        },
      },
    );

    const data = response as { id?: string };
    if (!data?.id) throw new CrmApiError('HubSpot contact creation failed', response);
    return {
      contact_id: data.id,
      status: 'created',
      provider: 'hubspot',
    };
  }

  private async salesforceCreate(config: CrmConfig, args: CrmContactArgs): Promise<CrmResult> {
    const apiKey = config.api_key;
    if (!apiKey) throw new CrmAuthError('Salesforce API key required');
    if (config.base_url && isUrlBlocked(config.base_url)) {
      throw new CrmAuthError('CRM base_url resolves to a blocked address.');
    }

    const nameParts = args.full_name.trim().split(/\s+/);
    const firstName = nameParts[0] ?? '';
    const lastName = nameParts.slice(1).join(' ');

    const response = await this.httpPost(
      `${config.base_url}/services/data/v59.0/sobjects/Contact`,
      {
        FirstName: firstName,
        LastName: lastName,
        Phone: args.phone ?? '',
        Email: args.email ?? '',
        Description: args.notes ?? '',
      },
      { Authorization: `Bearer ${apiKey}` },
    );

    const data = response as { id?: string; success?: boolean };
    if (!data?.id) throw new CrmApiError('Salesforce contact creation failed', response);
    return {
      contact_id: data.id,
      status: data.success ? 'created' : 'updated',
      provider: 'salesforce',
    };
  }

  private async genericCreate(config: CrmConfig, args: CrmContactArgs): Promise<CrmResult> {
    const url = config.base_url;
    if (!url) throw new CrmAuthError('Generic CRM requires a base_url');
    if (isUrlBlocked(url)) throw new CrmAuthError('CRM base_url resolves to a blocked address.');

    const response = await this.httpPost(url, {
      name: args.full_name,
      phone: args.phone,
      email: args.email,
      notes: args.notes,
      company: args.company,
    });

    const data = response as { id?: string };
    return {
      contact_id: data?.id ?? 'unknown',
      status: 'created',
      provider: 'generic',
    };
  }

  private async httpPost(
    url: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CrmApiError(`CRM HTTP ${response.status}: ${text.slice(0, 200)}`, { status: response.status, body: text });
    }

    return response.json();
  }
}

export class CrmAuthError extends Error {
  readonly code = 'CRM_AUTH_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'CrmAuthError';
  }
}

export class CrmApiError extends Error {
  readonly code = 'CRM_API_ERROR';
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CrmApiError';
  }
}
