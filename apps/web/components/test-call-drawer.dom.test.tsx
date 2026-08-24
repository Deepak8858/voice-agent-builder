import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { TestSessionResult } from '@voiceforge/shared';

/**
 * The drawer owns the browser half of a free-plan browser test: it joins the
 * LiveKit room the API created, publishes a microphone track, and plays the
 * agent's audio. None of that is observable from `resolveTestCallTransport`,
 * which only decides *whether* to join, so these tests mount the component and
 * drive the room events it subscribes to.
 *
 * The failure this guards against is specific and silent: `livekit-client` does
 * not auto-play remote tracks, so forgetting to attach one produces a call that
 * connects, meters minutes, and is completely inaudible.
 */

const REALTIME_SESSION: TestSessionResult = {
  call_id: 'call-realtime',
  test_session_id: 'sess_1',
  pipeline: 'realtime',
  web_socket_url: 'wss://realtime.example/ws',
  livekit_url: null,
  room_name: null,
  token: 'realtime-secret',
  expires_at: new Date('2026-09-01T00:00:00Z').toISOString(),
};

const STANDARD_SESSION: TestSessionResult = {
  call_id: 'call-standard',
  test_session_id: 'voiceforge-test-call-standard',
  pipeline: 'standard',
  web_socket_url: null,
  livekit_url: 'wss://livekit.example',
  room_name: 'voiceforge-test-call-standard',
  token: 'livekit-token',
  expires_at: new Date('2026-09-01T00:00:00Z').toISOString(),
};

/** Mirrors the members of `livekit-client`'s Room that the drawer touches. */
class FakeRoom {
  static instances: FakeRoom[] = [];
  /** When set, the next `connect()` rejects with this error. */
  static connectError: Error | null = null;
  handlers = new Map<string, (payload?: unknown) => void>();
  canPlaybackAudio = true;
  connect = vi.fn(async () => {
    if (FakeRoom.connectError) throw FakeRoom.connectError;
  });
  disconnect = vi.fn(async () => {});
  startAudio = vi.fn(async () => {
    this.canPlaybackAudio = true;
  });
  localParticipant = { setMicrophoneEnabled: vi.fn(async () => {}) };

  constructor() {
    FakeRoom.instances.push(this);
  }

  on(event: string, handler: (payload?: unknown) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.(payload);
  }
}

const apiCall = vi.fn();
const toastError = vi.fn();

vi.mock('livekit-client', () => ({
  Room: FakeRoom,
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    AudioPlaybackStatusChanged: 'audioPlaybackChanged',
  },
  Track: { Kind: { Audio: 'audio', Video: 'video' } },
}));

vi.mock('@/lib/use-api', () => ({ useApi: () => ({ call: apiCall }) }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (msg: string) => toastError(msg) },
}));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TestCallDrawer } from './test-call-drawer';

function renderDrawer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TestCallDrawer workspaceId="w1" agentId="a1" />
    </QueryClientProvider>,
  );
}

/** Clicks "Test call" and waits for the join to settle. */
async function startTestCall(): Promise<void> {
  screen.getByRole('button', { name: /test call/i }).click();
  await waitFor(() => expect(apiCall).toHaveBeenCalled());
}

function audioTrack() {
  const element = document.createElement('audio');
  return { kind: 'audio', attach: vi.fn(() => element), element };
}

beforeEach(() => {
  FakeRoom.instances = [];
  FakeRoom.connectError = null;
  apiCall.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TestCallDrawer live audio', () => {
  it('joins the room and publishes a microphone track for an in-house session', async () => {
    apiCall.mockResolvedValue(STANDARD_SESSION);
    renderDrawer();
    await startTestCall();

    await waitFor(() => expect(FakeRoom.instances).toHaveLength(1));
    const room = FakeRoom.instances[0]!;
    expect(room.connect).toHaveBeenCalledWith('wss://livekit.example', 'livekit-token');
    // Without a published mic the agent hears silence while minutes are metered.
    await waitFor(() =>
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true),
    );
    await waitFor(() => expect(screen.getByText(/Live — speak to the agent/i)).toBeDefined());
  });

  it('attaches the agent audio track to the document so the agent is audible', async () => {
    apiCall.mockResolvedValue(STANDARD_SESSION);
    renderDrawer();
    await startTestCall();
    await waitFor(() => expect(FakeRoom.instances).toHaveLength(1));
    const room = FakeRoom.instances[0]!;

    const track = audioTrack();
    act(() => room.emit('trackSubscribed', track));

    expect(track.attach).toHaveBeenCalled();
    expect(document.body.contains(track.element)).toBe(true);
  });

  it('ignores non-audio tracks', async () => {
    apiCall.mockResolvedValue(STANDARD_SESSION);
    renderDrawer();
    await startTestCall();
    await waitFor(() => expect(FakeRoom.instances).toHaveLength(1));
    const room = FakeRoom.instances[0]!;

    const video = { kind: 'video', attach: vi.fn() };
    act(() => room.emit('trackSubscribed', video));

    expect(video.attach).not.toHaveBeenCalled();
  });

  it('surfaces an Enable sound control when the browser blocks playback', async () => {
    apiCall.mockResolvedValue(STANDARD_SESSION);
    renderDrawer();
    await startTestCall();
    await waitFor(() => expect(FakeRoom.instances).toHaveLength(1));
    const room = FakeRoom.instances[0]!;

    // Autoplay refusal is indistinguishable from a broken pipeline unless it is
    // surfaced, so the drawer must offer the gesture rather than look connected.
    room.canPlaybackAudio = false;
    act(() => room.emit('audioPlaybackChanged'));

    const enable = await waitFor(() => screen.getByRole('button', { name: /enable sound/i }));
    await act(async () => enable.click());

    expect(room.startAudio).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/Live — speak to the agent/i)).toBeDefined());
  });

  it('does not touch livekit-client for a realtime session', async () => {
    apiCall.mockResolvedValue(REALTIME_SESSION);
    renderDrawer();
    await startTestCall();

    // Paid plans keep the speech-to-speech path; joining a room would be wrong
    // and would pull the WebRTC bundle into a page that never needs it.
    expect(FakeRoom.instances).toHaveLength(0);
  });

  it('reports a failed join instead of leaving the drawer looking connected', async () => {
    apiCall.mockResolvedValue(STANDARD_SESSION);
    FakeRoom.connectError = new Error('handshake refused');
    renderDrawer();
    await startTestCall();

    // The transcript view stays usable, but the user must be told the audio leg
    // never came up rather than being shown a connected-looking drawer.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('handshake refused')),
    );
    await waitFor(() => expect(screen.getByText(/Live audio unavailable/i)).toBeDefined());
    await waitFor(() => expect(FakeRoom.instances[0]!.disconnect).toHaveBeenCalled());
  });

  it('disconnects and removes audio elements when the drawer unmounts', async () => {
    apiCall.mockResolvedValue(STANDARD_SESSION);
    const { unmount } = renderDrawer();
    await startTestCall();
    await waitFor(() => expect(FakeRoom.instances).toHaveLength(1));
    const room = FakeRoom.instances[0]!;

    const track = audioTrack();
    act(() => room.emit('trackSubscribed', track));
    expect(document.body.contains(track.element)).toBe(true);

    unmount();

    // A room left connected keeps metering a conversation nobody is having.
    expect(room.disconnect).toHaveBeenCalled();
    expect(document.body.contains(track.element)).toBe(false);
  });
});
