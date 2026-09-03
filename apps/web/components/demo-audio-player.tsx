'use client';

import { useState, useRef } from 'react';
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

export function DemoAudioPlayer(props: DemoAudioPlayerProps) {
  const playerKey = `${props.src ?? 'missing'}-${props.duration ?? 30}`;

  return <DemoAudioPlayerInner key={playerKey} {...props} />;
}

function DemoAudioPlayerInner({
  src,
  label = 'See it in action',
  caption = 'AI-generated call · Real voice agent · No humans involved',
  duration = 30,
}: DemoAudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(duration);
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = async () => {
    if (!src || audioUnavailable) return;

    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
    } else {
      try {
        await audioRef.current?.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
        setAudioUnavailable(true);
      }
    }
  };

  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  if (!src || audioUnavailable) {
    return (
      <div className="relative mx-auto mt-8 w-full max-w-2xl min-w-0">
        <div className="relative flex min-w-0 items-center gap-4 rounded-md border border-[#d7d0c3] bg-[#fbf6ea] p-4 opacity-70">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-[#e8f2df] text-[#23594f]">
            <Mic2 className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate text-[#51615a]">{label}</p>
            <p className="text-xs text-[#66736c] mt-1">
              {src ? 'Audio preview unavailable' : 'Demo audio coming soon'}
            </p>
          </div>
          <span className="shrink-0 text-xs text-[#66736c] font-mono">
            0:00 / 0:30
          </span>
        </div>
        <p className="mt-2 text-center text-xs text-[#66736c]">{caption}</p>
      </div>
    );
  }

  return (
    <div className="relative mx-auto mt-8 w-full max-w-2xl min-w-0">
      <audio
        ref={audioRef}
        preload="none"
        onLoadedMetadata={() => {
          setTotalDuration(audioRef.current?.duration ?? duration);
        }}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
        onTimeUpdate={() => {
          setCurrentTime(audioRef.current?.currentTime ?? 0);
        }}
        onError={() => {
          setIsPlaying(false);
          setCurrentTime(0);
          setAudioUnavailable(true);
        }}
      >
        {/*
          Compressed sources first: the original 44s mono WAV is 1.96 MB and,
          even at preload="metadata", browsers pulled enough of it to compete
          with the hero LCP image for mobile bandwidth. Opus is ~117 KB and
          MP3 ~267 KB; the WAV stays last as a universal fallback.

          Variants are derived from the parsed pathname, so a src carrying a
          query string or fragment (or any non-.wav extension) is served as-is
          instead of being rewritten to a URL with the wrong MIME type.
        */}
        {src ? (
          <>
            {(() => {
              // Relative URLs need a base for URL parsing; it is never emitted.
              let pathname: string;
              try {
                pathname = new URL(src, 'http://x.invalid').pathname;
              } catch {
                return <source src={src} />;
              }
              if (!/\.wav$/i.test(pathname)) return <source src={src} />;
              const swap = (ext: string) =>
                src.replace(pathname, pathname.replace(/\.wav$/i, ext));
              return (
                <>
                  <source src={swap('.opus')} type="audio/ogg; codecs=opus" />
                  <source src={swap('.mp3')} type="audio/mpeg" />
                  <source src={src} type="audio/wav" />
                </>
              );
            })()}
          </>
        ) : null}
      </audio>
      <div className="relative flex min-w-0 items-center gap-4 rounded-md border border-[#d7d0c3] bg-[#fbf6ea] p-4">
        <button
          onClick={togglePlay}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-[#07130f] text-[#fbf5e7] shadow-lg shadow-[#07130f]/15 transition-colors hover:bg-[#23594f]"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <Pause className="h-5 w-5" />
          ) : (
            <Play className="h-5 w-5 ml-0.5" />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate text-[#07130f]">{label}</p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-[#d7d0c3]">
            <div
              className="h-full bg-[#bfff4a] transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <span className="shrink-0 text-xs text-[#66736c] font-mono">
          {formatTime(currentTime)} / {formatTime(totalDuration)}
        </span>
      </div>
      <p className="mt-2 text-center text-xs text-[#66736c]">{caption}</p>
    </div>
  );
}
