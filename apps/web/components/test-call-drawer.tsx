'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CallDetail, TestSessionResult } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { StatusBadge } from '@/components/dashboard/status-badge';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/cn';
import { resolveTestCallTransport } from '@/lib/test-call-transport';
import { ArrowRight, Clock3, MessageSquareText, Mic, Phone } from 'lucide-react';
import posthog from 'posthog-js';

interface TestCallDrawerProps {
  workspaceId: string;
  agentId: string;
}

/** Live-audio state for a test served by the in-house pipeline. */
type LiveAudioState = 'idle' | 'connecting' | 'connected' | 'blocked' | 'failed';

export function TestCallDrawer({ workspaceId, agentId }: TestCallDrawerProps) {
  const { call } = useApi();
  const [open, setOpen] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);
  const [liveAudio, setLiveAudio] = useState<LiveAudioState>('idle');
  // `livekit-client` is only imported for in-house sessions, and only in the
  // browser, so the realtime path never pays for the WebRTC bundle.
  const roomRef = useRef<import('livekit-client').Room | null>(null);
  // Remote audio is not played automatically by livekit-client, so the agent's
  // track has to be attached to an element this component owns and detached on
  // teardown.
  const audioElementsRef = useRef<HTMLMediaElement[]>([]);

  const disconnectRoom = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    for (const element of audioElementsRef.current) element.remove();
    audioElementsRef.current = [];
    setLiveAudio('idle');
    void room?.disconnect();
  }, []);

  const joinLiveAudio = useCallback(
    async (session: TestSessionResult) => {
      const transport = resolveTestCallTransport(session);
      if (transport.kind === 'none') return;

      setLiveAudio('connecting');
      try {
        const { Room, RoomEvent, Track } = await import('livekit-client');
        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;

        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio) return;
          const element = track.attach();
          audioElementsRef.current.push(element);
          document.body.appendChild(element);
        });
        // Browsers can refuse playback until the user gesture is recognised, and
        // a silent agent looks identical to a broken pipeline. Surface it so the
        // user can click to enable sound instead of assuming the test failed.
        room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
          setLiveAudio((prev) =>
            prev === 'idle' || prev === 'failed'
              ? prev
              : room.canPlaybackAudio
                ? 'connected'
                : 'blocked',
          );
        });

        await room.connect(transport.url, transport.token);
        // The worker is already dispatched into the room, so the only thing left
        // is a microphone track. Without it the agent hears silence and the test
        // burns metered minutes on nothing.
        await room.localParticipant.setMicrophoneEnabled(true);
        setLiveAudio(room.canPlaybackAudio ? 'connected' : 'blocked');
      } catch (err) {
        // A failed join must not look like a working call: the transcript view
        // stays usable, but the user is told the audio leg did not come up.
        disconnectRoom();
        setLiveAudio('failed');
        toast.error(
          err instanceof Error
            ? `Could not join the test call: ${err.message}`
            : 'Could not join the test call.',
        );
      }
    },
    [disconnectRoom],
  );

  const allowAudioPlayback = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.startAudio();
      setLiveAudio('connected');
    } catch {
      // Staying in `blocked` keeps the retry affordance on screen.
    }
  }, []);

  const startMutation = useMutation({
    mutationFn: async () =>
      call<TestSessionResult>(
        `/workspaces/${workspaceId}/agents/${agentId}/test-session`,
        { method: 'POST', body: JSON.stringify({ contact_name: 'Browser tester' }) },
      ),
    onSuccess: (res) => {
      setCallId(res.call_id);
      setOpen(true);
      posthog.capture('test_call_started', { pipeline: res.pipeline });
      toast.success('Test session created.');
      void joinLiveAudio(res);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Unmount tears the call leg down. Leaving the room connected would keep
  // metering minutes for a conversation nobody is having.
  useEffect(() => disconnectRoom, [disconnectRoom]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      // Closing is an explicit hang-up, handled here rather than in an effect so
      // the disconnect is tied to the user's action instead of a render pass.
      if (!next) disconnectRoom();
    },
    [disconnectRoom],
  );

  const detailQuery = useQuery({
    queryKey: ['call', workspaceId, callId],
    enabled: Boolean(callId),
    queryFn: () => call<CallDetail>(`/workspaces/${workspaceId}/calls/${callId}`),
  });

  const turns = detailQuery.data?.turns ?? [];

  return (
    <>
      <Button
        variant="outline"
        type="button"
        onClick={() => startMutation.mutate()}
        disabled={startMutation.isPending || !workspaceId}
        className="gap-2"
      >
        <Phone className="h-4 w-4" />
        {startMutation.isPending ? 'Starting…' : 'Test call'}
      </Button>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        {/* ph-no-capture: the drawer renders the test-call transcript. */}
        <SheetContent
          side="right"
          className="ph-no-capture flex h-full w-full flex-col p-0 sm:max-w-xl"
        >
          <SheetHeader className="border-b border-border px-6 py-5 pr-12 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle>Browser test call</SheetTitle>
              <StatusBadge status={detailQuery.data?.status ?? 'pending'} />
            </div>
            <SheetDescription>
              Review the generated browser test transcript before opening the full call record.
            </SheetDescription>
          </SheetHeader>

          {liveAudio === 'idle' ? null : (
            <div
              className={cn(
                'flex items-center gap-2 border-b px-6 py-3 text-xs',
                liveAudio === 'failed'
                  ? 'border-destructive/30 bg-destructive/5 text-destructive'
                  : 'border-border bg-muted/40 text-muted-foreground',
              )}
            >
              <Mic
                className={cn('h-3.5 w-3.5', liveAudio === 'connecting' && 'animate-pulse')}
              />
              {liveAudio === 'connecting'
                ? 'Connecting your microphone…'
                : liveAudio === 'connected'
                  ? 'Live — speak to the agent. Closing this drawer ends the call.'
                  : liveAudio === 'blocked'
                    ? 'Your browser blocked playback, so you cannot hear the agent yet.'
                    : 'Live audio unavailable. The transcript still updates below.'}
              {liveAudio === 'blocked' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7 text-xs"
                  onClick={() => void allowAudioPlayback()}
                >
                  Enable sound
                </Button>
              ) : null}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailQuery.isPending ? (
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                <Clock3 className="h-4 w-4 animate-pulse" />
                Loading transcript…
              </div>
            ) : turns.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {turns.map((turn, idx) => {
                  const isAgent = turn.speaker === 'agent';
                  return (
                    <li
                      key={`${turn.speaker}-${turn.at_ms}-${idx}`}
                      className={cn(
                        'flex max-w-[88%] flex-col rounded-2xl border px-4 py-3 text-sm shadow-sm',
                        isAgent
                          ? 'self-start border-border bg-muted/70'
                          : 'self-end border-primary/20 bg-primary text-primary-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'mb-1 text-[10px] font-semibold uppercase tracking-[0.18em]',
                          isAgent ? 'text-muted-foreground' : 'text-primary-foreground/75',
                        )}
                      >
                        {turn.speaker} · {Math.round(turn.at_ms / 1000)}s
                      </span>
                      <span>{turn.text}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex min-h-72 flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-muted/30 px-6 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <MessageSquareText className="h-6 w-6" />
                </div>
                <p className="font-medium text-foreground">No transcript yet</p>
                <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
                  The transcript appears here after the browser test session creates turns.
                </p>
              </div>
            )}
          </div>

          <SheetFooter className="border-t border-border px-6 py-4 sm:justify-between sm:space-x-0">
            <span className="text-xs text-muted-foreground">
              {callId ? `Call ${callId.slice(0, 8)}` : 'Browser test session'}
            </span>
            {callId ? (
              <Button asChild variant="outline" size="sm" className="gap-2">
                <Link href={`/dashboard/calls/${callId}`}>
                  Open full call
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}