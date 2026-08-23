import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_REAUTH_REQUIRED_MESSAGE } from '../../google-connection/google-connection.service';
import { GoogleCalendarExecutor } from './google-calendar.executor';
import { safeFetch } from '../../common/safe-fetch';

vi.mock('../../common/safe-fetch', () => ({
  safeFetch: vi.fn(),
}));

function makeExecutor() {
  const googleConnection = {
    getUsableAccessToken: vi.fn(async () => 'workspace-access-token'),
  };
  return {
    executor: new GoogleCalendarExecutor(googleConnection as never),
    googleConnection,
  };
}

describe('GoogleCalendarExecutor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires a workspace-scoped invocation before resolving credentials', async () => {
    const { executor, googleConnection } = makeExecutor();

    const result = await executor.execute(
      { operation: 'list_events' },
      { calendar_id: 'primary' },
    );

    expect(result).toEqual({
      success: false,
      error: 'Calendar tool requires a workspace-scoped invocation.',
    });
    expect(googleConnection.getUsableAccessToken).not.toHaveBeenCalled();
  });

  it('uses the unified workspace Google connection for event creation', async () => {
    const { executor, googleConnection } = makeExecutor();
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'event-1',
      htmlLink: 'https://calendar.google.com/event-1',
    }), { status: 200 }));

    const result = await executor.execute(
      {
        operation: 'create_event',
        summary: 'Consultation',
        start_iso: '2026-08-24T10:00:00.000Z',
        end_iso: '2026-08-24T10:30:00.000Z',
      },
      { calendar_id: 'primary' },
      { workspaceId: 'workspace-1' },
    );

    expect(googleConnection.getUsableAccessToken).toHaveBeenCalledWith('workspace-1');
    expect(safeFetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer workspace-access-token' }),
      }),
    );
    expect(result).toEqual({
      success: true,
      result: {
        event_id: 'event-1',
        html_link: 'https://calendar.google.com/event-1',
      },
    });
  });

  it('returns the reconnect message when token resolution requires reauthorization', async () => {
    const { executor, googleConnection } = makeExecutor();
    googleConnection.getUsableAccessToken.mockRejectedValueOnce(
      new Error(GOOGLE_REAUTH_REQUIRED_MESSAGE),
    );

    const result = await executor.execute(
      { operation: 'list_events' },
      { calendar_id: 'primary' },
      { workspaceId: 'workspace-1' },
    );

    expect(result).toEqual({ success: false, error: GOOGLE_REAUTH_REQUIRED_MESSAGE });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('maps a Google 401 response to the reconnect message without exposing the body', async () => {
    const { executor } = makeExecutor();
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response('access_token=secret-provider-value', { status: 401 }),
    );

    const result = await executor.execute(
      { operation: 'list_events' },
      { calendar_id: 'primary' },
      { workspaceId: 'workspace-1' },
    );

    expect(result).toEqual({ success: false, error: GOOGLE_REAUTH_REQUIRED_MESSAGE });
  });

  it('does not retry non-idempotent event creation after a transport failure', async () => {
    const { executor } = makeExecutor();
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error('network timeout'));

    const result = await executor.execute(
      {
        operation: 'create_event',
        summary: 'Consultation',
        start_iso: '2026-08-24T10:00:00.000Z',
        end_iso: '2026-08-24T10:30:00.000Z',
      },
      { calendar_id: 'primary' },
      { workspaceId: 'workspace-1' },
    );

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      error: 'Google Calendar request failed — please try again shortly.',
    });
  });
});
