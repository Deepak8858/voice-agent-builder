import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GoogleCalendarExecutor } from './google-calendar-executor';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-04-27T12:00:00Z');

function makePrisma(calendarConfig?: Record<string, unknown>) {
  return {
    googleCalendarConfig: {
      findUnique: vi.fn(async () => calendarConfig ?? null),
      update: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
        ...calendarConfig,
        ...args.data,
      })),
    },
  };
}

describe('GoogleCalendarExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('bookSlot', () => {
    it('returns auth error when workspace has no calendar config', async () => {
      const executor = new GoogleCalendarExecutor(makePrisma() as never);
      await expect(
        executor.bookSlot(WORKSPACE_ID, {
          full_name: 'Alice Smith',
          phone: '+14155551212',
          preferred_date: '2026-05-01',
          preferred_time: '14:00',
        }),
      ).rejects.toThrow('Google Calendar not connected');
    });

    it('creates a calendar event with valid token', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'event-123',
            htmlLink: 'https://calendar.google.com/event?eid=abc',
            summary: 'Voice Agent Booking - Alice Smith',
            start: { dateTime: '2026-05-01T14:00:00Z' },
          }),
      });
      global.fetch = mockFetch;

      const prisma = makePrisma({
        id: 'cfg-1',
        workspaceId: WORKSPACE_ID,
        accessToken: 'valid-token',
        refreshToken: 'refresh-token',
        tokenExpiry: new Date(Date.now() + 3600_000).toISOString(),
        calendarId: 'primary',
      });
      const executor = new GoogleCalendarExecutor(prisma as never);

      const result = await executor.bookSlot(WORKSPACE_ID, {
        full_name: 'Alice Smith',
        phone: '+14155551212',
        preferred_date: '2026-05-01',
        preferred_time: '14:00',
      });

      expect(result.event_id).toBe('event-123');
      expect(result.html_link).toBe('https://calendar.google.com/event?eid=abc');
      expect(result.summary).toBe('Voice Agent Booking - Alice Smith');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.summary).toBe('Voice Agent Booking - Alice Smith');
      expect(body.description).toContain('+14155551212');
      expect(body.start.dateTime).toBe('2026-05-01T14:00:00');
    });

    it('returns API error with non-2xx response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({ error: { message: 'Insufficient permission' } }),
      });
      global.fetch = mockFetch;

      const prisma = makePrisma({
        workspaceId: WORKSPACE_ID,
        accessToken: 'bad-token',
        refreshToken: 'refresh-token',
        tokenExpiry: new Date(Date.now() + 3600_000).toISOString(),
        calendarId: 'primary',
      });
      const executor = new GoogleCalendarExecutor(prisma as never);

      await expect(
        executor.bookSlot(WORKSPACE_ID, {
          full_name: 'Bob',
          phone: '+14155559999',
          preferred_date: '2026-06-01',
          preferred_time: '10:00',
        }),
      ).rejects.toThrow('Insufficient permission');
    });
  });
});
