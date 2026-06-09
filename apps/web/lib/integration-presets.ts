export type ConnectionProviderId =
  | 'google_calendar'
  | 'hubspot'
  | 'salesforce'
  | 'pipedrive'
  | 'generic_webhook';

export type RecommendedAuth = 'oauth' | 'private_app_token' | 'api_token' | 'webhook';

export interface ConnectionPreset {
  id: ConnectionProviderId;
  name: string;
  category: 'calendar' | 'crm';
  description: string;
  docsUrl: string;
  scopes: string[];
  auth: {
    recommended: RecommendedAuth;
    label: string;
    summary: string;
  };
  manualFallback: {
    label: string;
    summary: string;
    fields: string[];
  };
}

const CONNECTION_PRESETS: ConnectionPreset[] = [
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    category: 'calendar',
    description: 'Check availability and create booked appointments during calls.',
    docsUrl: 'https://developers.google.com/workspace/calendar/api/auth',
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
    ],
    auth: {
      recommended: 'oauth',
      label: 'Connect with Google',
      summary: 'Use OAuth with offline access so VoiceForge can refresh tokens without asking users to paste secrets.',
    },
    manualFallback: {
      label: 'Manual OAuth token',
      summary: 'Use a refresh token only when you are testing or connecting a single owned calendar.',
      fields: ['refresh_token', 'calendar_id'],
    },
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'crm',
    description: 'Create or update qualified contacts after calls.',
    docsUrl: 'https://developers.hubspot.com/docs/api/working-with-oauth',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
    auth: {
      recommended: 'oauth',
      label: 'Connect HubSpot',
      summary: 'OAuth is best for customer workspaces and marketplace-ready multi-account installs.',
    },
    manualFallback: {
      label: 'Private app token',
      summary: 'For a single HubSpot account, paste a scoped private app access token with contact read/write access.',
      fields: ['private_app_access_token'],
    },
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'crm',
    description: 'Push leads and call notes into Salesforce contacts.',
    docsUrl: 'https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm&type=5',
    scopes: ['api', 'refresh_token'],
    auth: {
      recommended: 'oauth',
      label: 'Connect Salesforce',
      summary: 'Use the OAuth web server flow through a Connected App for multi-tenant installs.',
    },
    manualFallback: {
      label: 'Access token',
      summary: 'For testing, paste a bearer token and Salesforce instance URL.',
      fields: ['access_token', 'instance_url'],
    },
  },
  {
    id: 'pipedrive',
    name: 'Pipedrive',
    category: 'crm',
    description: 'Create people records for appointment, service, or sales leads.',
    docsUrl: 'https://pipedrive.readme.io/docs/core-api-concepts-authentication',
    scopes: ['contacts:full'],
    auth: {
      recommended: 'oauth',
      label: 'Connect Pipedrive',
      summary: 'OAuth is the cleanest path for public or unlisted Pipedrive apps.',
    },
    manualFallback: {
      label: 'API token',
      summary: 'For one owned Pipedrive company, use the account API token and optional company API base URL.',
      fields: ['api_token', 'base_url'],
    },
  },
  {
    id: 'generic_webhook',
    name: 'Generic webhook',
    category: 'crm',
    description: 'Send contact payloads to Zapier, Make, n8n, or a custom CRM endpoint.',
    docsUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods/POST',
    scopes: [],
    auth: {
      recommended: 'webhook',
      label: 'Connect webhook',
      summary: 'Use a public HTTPS endpoint when the CRM does not have a dedicated adapter yet.',
    },
    manualFallback: {
      label: 'Webhook URL',
      summary: 'VoiceForge sends contact name, phone, email, company, and notes to this URL.',
      fields: ['webhook_url'],
    },
  },
];

export function getConnectionPresets(): ConnectionPreset[] {
  return CONNECTION_PRESETS;
}

export function getConnectionPreset(id: ConnectionProviderId): ConnectionPreset {
  return CONNECTION_PRESETS.find((preset) => preset.id === id) ?? CONNECTION_PRESETS[0];
}

export function recommendedOauthProviders(): ConnectionProviderId[] {
  return CONNECTION_PRESETS
    .filter((preset) => preset.auth.recommended === 'oauth')
    .map((preset) => preset.id);
}
