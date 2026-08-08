import { describe, expect, it, vi, beforeEach } from 'vitest';
import { safeFetch } from '../common/safe-fetch';
import { CrmExecutor } from './crm-executor';
vi.mock('../common/safe-fetch', () => ({ safeFetch: vi.fn() }));

function mockFetch(response: unknown, ok = true) {
  const fn = vi.fn(async () => new Response(JSON.stringify(response), {
    status: ok ? 200 : 400,
    headers: { 'content-type': 'application/json' },
  }));
  vi.mocked(safeFetch).mockImplementation(fn);
  return fn;
}

describe('CrmExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pipedriveCreate', () => {
    it('creates a contact and returns contact_id', async () => {
      mockFetch({ data: { id: 42 } });
      const executor = new CrmExecutor();
      const result = await executor.createContact('pipedrive', { api_key: 'test-key' }, {
        full_name: 'Alice Bob',
        phone: '+14155551212',
        company: 'Acme Inc',
      });
      expect(result.contact_id).toBe('42');
      expect(result.status).toBe('created');
      expect(result.provider).toBe('pipedrive');
    });

    it('throws CrmAuthError when api_key missing', async () => {
      const executor = new CrmExecutor();
      await expect(
        executor.createContact('pipedrive', {}, { full_name: 'Alice' }),
      ).rejects.toThrow('API key required');
    });

    it('throws CrmApiError when response has no id', async () => {
      mockFetch({ data: null });
      const executor = new CrmExecutor();
      await expect(
        executor.createContact('pipedrive', { api_key: 'bad' }, { full_name: 'Alice' }),
      ).rejects.toThrow('creation failed');
    });
  });

  describe('hubspotCreate', () => {
    it('creates a contact and returns contact_id', async () => {
      mockFetch({ id: 'hs-123' });
      const executor = new CrmExecutor();
      const result = await executor.createContact('hubspot', { api_key: 'hs-key' }, {
        full_name: 'Bob Charlie',
        phone: '+14155559999',
        email: 'bob@example.com',
      });
      expect(result.contact_id).toBe('hs-123');
      expect(result.provider).toBe('hubspot');
    });

    it('uses bearer authorization for HubSpot private app or OAuth tokens', async () => {
      const fetch = mockFetch({ id: 'hs-123' });
      const executor = new CrmExecutor();

      await executor.createContact('hubspot', { api_key: 'hs-token' }, {
        full_name: 'Bob Charlie',
        email: 'bob@example.com',
      });

      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts');
      expect(url).not.toContain('hapikey=');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer hs-token' });
    });

    it('throws CrmAuthError when api_key missing', async () => {
      const executor = new CrmExecutor();
      await expect(
        executor.createContact('hubspot', {}, { full_name: 'Bob' }),
      ).rejects.toThrow('API key required');
    });
  });

  describe('salesforceCreate', () => {
    it('creates a contact with Bearer token', async () => {
      mockFetch({ id: 'sf-999', success: true });
      const executor = new CrmExecutor();
      const result = await executor.createContact('salesforce', {
        api_key: 'sf-token',
        base_url: 'https://instance.salesforce.com',
      }, { full_name: 'Carol Dan' });
      expect(result.contact_id).toBe('sf-999');
      expect(result.provider).toBe('salesforce');
    });

    it('throws CrmAuthError when api_key missing', async () => {
      const executor = new CrmExecutor();
      await expect(
        executor.createContact('salesforce', {}, { full_name: 'Carol' }),
      ).rejects.toThrow('API key required');
    });
  });

  describe('genericCreate', () => {
    it('forwards args to base_url as POST', async () => {
      const fetch = mockFetch({ id: 'gen-1' });
      const executor = new CrmExecutor();
      const result = await executor.createContact('generic', {
        base_url: 'https://my-crm.example.com/api/contacts',
      }, { full_name: 'Dan', phone: '+10000000000' });
      expect(result.contact_id).toBe('gen-1');
      expect(result.provider).toBe('generic');
      const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.name).toBe('Dan');
      expect(body.phone).toBe('+10000000000');
    });

    it('accepts the workspace CRM generic_webhook provider alias', async () => {
      mockFetch({ id: 'gen-2' });
      const executor = new CrmExecutor();

      const result = await executor.createContact('generic_webhook', {
        base_url: 'https://my-crm.example.com/api/contacts',
      }, { full_name: 'Eve' });

      expect(result.contact_id).toBe('gen-2');
      expect(result.provider).toBe('generic_webhook');
    });

    it('throws CrmAuthError when base_url missing', async () => {
      const executor = new CrmExecutor();
      await expect(
        executor.createContact('generic', {}, { full_name: 'Dan' }),
      ).rejects.toThrow('base_url');
    });
  });

  describe('error handling', () => {
    it('throws CrmApiError on HTTP failure', async () => {
      vi.mocked(safeFetch).mockResolvedValue(
        new Response('Service Unavailable', { status: 503 }),
      );
      const executor = new CrmExecutor();
      await expect(
        executor.createContact('generic', { base_url: 'https://fail.example' }, { full_name: 'Eve' }),
      ).rejects.toThrow('503');
    });
  });
});
