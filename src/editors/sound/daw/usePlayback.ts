import { useEffect, useRef, useState } from "react";
import { openAudio } from "../audio";
import { type Channels, type Mix, playMix } from "../montage";

// The montage played from the playhead as the build renders it: the
// playhead moved along while it plays, left where it stopped.

export interface Playback {
  position: number;
  /** The channels' analysers while playing, for the meters. */
  channels: Channels | null;
  play: () => void;
  /** Stops playing (`rewind`: the playhead back to the start). */
  stop: (rewind?: boolean) => void;
  seek: (at: number) => void;
}

export function usePlayback(shown: Mix, buffers: (AudioBuffer | null)[], length: number): Playback {
  const [position, setPosition] = useState(0);
  const [channels, setChannels] = useState<Channels | null>(null);
  const playing = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => playing.current?.stop(), []);

  const stop = (rewind = false) => {
    playing.current?.stop();
    if (rewind) setPosition(0);
  };
  const play = () => {
    stop();
    const { ctx, release } = openAudio();
    const from = position >= length ? 0 : position;
    const start = ctx.currentTime;
    const { sources, channels: ch } = playMix(ctx, shown, buffers, ctx.destination, start, from);
    setChannels(ch);
    let frame = 0;
    const end = (at: number) => {
      sources.forEach((s) => s.stop());
      release();
      cancelAnimationFrame(frame);
      setChannels(null);
      setPosition(at);
      playing.current = null;
    };
    const tick = () => {
      const now = from + ctx.currentTime - start;
      if (now >= length) return end(length);
      setPosition(now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    playing.current = { stop: () => end(from + ctx.currentTime - start) };
  };
  return { position, channels, play, stop, seek: (at) => (stop(), setPosition(at)) };
}
