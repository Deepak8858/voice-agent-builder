'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallTurn } from '@voiceforge/shared';
import { cn } from '@/lib/cn';

interface LiveEvent {
  type: string;
  call_id: string;
  event_time: string;
  data?: Record<string, unknown>;
}

interface TranscriptSegment {
  speaker: 'agent' | 'caller';
  text: string;
  at_ms: number;
}

interface CallLiveMonitorProps {
  callId: string;
  workspaceId: string;
  /** Pre-loaded transcript from the GET /calls/:id endpoint */
  initialTurns?: CallTurn[];
  initialStatus?: string;
}

export function CallLiveMonitor({
  callId,
  workspaceId,
  initialTurns = [],
  initialStatus,
}: CallLiveMonitorProps) {
  const [turns, setTurns] = useState<TranscriptSegment[]>(
    initialTurns.map((t) => ({ speaker: t.speaker, text: t.text, at_ms: t.at_ms })),
  );
  const [status, setStatus] = useState<string>(initialStatus ?? 'connecting');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }
    const url = `/api/proxy/workspaces/${workspaceId}/calls/${callId}/live`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onmessage = (e) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(e.data) as LiveEvent;
      } catch {
        return;
      }

      // Update call status
      if (event.type === 'call.started') setStatus('in_progress');
      if (event.type === 'call.ended') setStatus('completed');

      // Extract transcript segments from Vapi-style payload
      const data = event.data ?? {};
      const segments: TranscriptSegment[] | undefined =
        (data.segments as TranscriptSegment[]) ??
        (data.transcript_segments as TranscriptSegment[]) ??
        (data.message as { transcript?: TranscriptSegment[] })?.transcript;

      if (segments?.length) {
        setTurns((prev) => {
          // Deduplicate by at_ms — Vapi may send same segment multiple times
          const prevKeys = new Set(prev.map((t) => `${t.speaker}:${t.at_ms}`));
          const newSegs = segments.filter(
            (s) => !prevKeys.has(`${s.speaker}:${s.at_ms}`),
          );
          return [...prev, ...newSegs].sort((a, b) => a.at_ms - b.at_ms);
        });
      }

      // Handle end of call
      if (event.type === 'call.ended') {
        es.close();
        setConnected(false);
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      // Auto-reconnect every 3s for active calls
      if (status !== 'completed') {
        reconnectTimer.current = setTimeout(connect, 3000);
      }
    };
  }, [callId, workspaceId, status]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  // Auto-scroll to bottom on new turns
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length]);

  return (
    <div className="flex flex-col gap-3">
      {/* Status bar */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            connected ? 'bg-emerald-500 animate-pulse' : 'bg-muted',
          )}
        />
        <span className="text-xs text-muted-foreground capitalize">{status.replace('_', ' ')}</span>
        {error && <span className="text-xs text-destructive ml-auto">{error}</span>}
        {!connected && status !== 'completed' && (
          <span className="text-xs text-muted-foreground ml-auto">Reconnecting...</span>
        )}
      </div>

      {/* Transcript bubbles */}
      {turns.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {turns.map((t, idx) => (
            <li
              key={idx}
              className={cn(
                'flex max-w-[85%] flex-col rounded-xl px-4 py-3 text-sm',
                t.speaker === 'agent'
                  ? 'self-start bg-muted border border-border'
                  : 'self-end bg-primary/10 text-primary-foreground border border-primary/20',
              )}
            >
              <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1">
                {t.speaker} · {Math.round(t.at_ms / 1000)}s
              </span>
              <span className="text-foreground">{t.text}</span>
            </li>
          ))}
          <div ref={bottomRef} />
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {connected ? 'Waiting for first message...' : 'Connecting to call...'}
        </p>
      )}
    </div>
  );
}