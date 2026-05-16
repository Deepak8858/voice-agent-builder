'use client';

import { useState, useRef, useEffect } from 'react';
import { Play, Pause, Mic2 } from 'lucide-react';

interface DemoAudioPlayerProps {
  /** URL to the demo audio file */
  src?: string;
  /** Label shown above the player */
  label?: string;
  /** Caption shown below the player */
  caption?: string;
  /** Duration in seconds (used if src not available) */
  duration?: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function DemoAudioPlayer({
  src,
  label = 'See it in action',
  caption = 'AI-generated call · Real voice agent · No humans involved',
  duration = 30,
}: DemoAudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(duration);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (audioRef.current && src) {
      audioRef.current.onloadedmetadata = () => {
        setTotalDuration(audioRef.current?.duration ?? duration);
      };
      audioRef.current.onended = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
      audioRef.current.ontimeupdate = () => {
        setCurrentTime(audioRef.current?.currentTime ?? 0);
      };
    }
  }, [src, duration]);

  const togglePlay = () => {
    if (!src) return;

    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
    } else {
      audioRef.current?.play();
      setIsPlaying(true);
    }
  };

  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  // If no audio src, show a placeholder UI
  if (!src) {
    return (
      <div className="relative mx-auto max-w-2xl mt-8">
        <div className="relative flex items-center gap-4 rounded-2xl border border-border/50 bg-card/80 p-4 opacity-60">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Mic2 className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate text-muted-foreground">{label}</p>
            <p className="text-xs text-muted-foreground mt-1">Demo audio coming soon</p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground font-mono">
            0:00 / 0:30
          </span>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">{caption}</p>
      </div>
    );
  }

  return (
    <div className="relative mx-auto max-w-2xl mt-8">
      <audio ref={audioRef} src={src} preload="metadata" />
      <div className="relative flex items-center gap-4 rounded-2xl border border-border/50 bg-card/80 p-4">
        <button
          onClick={togglePlay}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <Pause className="h-5 w-5" />
          ) : (
            <Play className="h-5 w-5 ml-0.5" />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{label}</p>
          <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground font-mono">
          {formatTime(currentTime)} / {formatTime(totalDuration)}
        </span>
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}