import { useEffect, useRef } from "react";
import { peaks } from "./audio";

// A sound's waveform: its loudness along its length, and where it's playing.

/** The waveform's colour, and where the playhead is drawn. */
const WAVE = "#9d7bea";
const HEAD = "#ffffff";

/** Each buffer's peaks, per width drawn: a moving playhead only redraws. */
const peakCache = new WeakMap<AudioBuffer, Map<number, Float32Array>>();

function cachedPeaks(buffer: AudioBuffer, width: number): Float32Array {
  let byWidth = peakCache.get(buffer);
  if (!byWidth) peakCache.set(buffer, (byWidth = new Map()));
  let p = byWidth.get(width);
  if (!p) byWidth.set(width, (p = peaks(buffer, width)));
  return p;
}

export function Waveform({ buffer, at }: { buffer: AudioBuffer | null; at: number | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    g.clearRect(0, 0, w, h);
    if (!buffer) return;
    const p = cachedPeaks(buffer, w);
    g.fillStyle = WAVE;
    for (let x = 0; x < w; x++) {
      const half = (p[x] * h) / 2;
      g.fillRect(x, h / 2 - half, 1, Math.max(1, half * 2));
    }
    if (at !== null) {
      g.fillStyle = HEAD;
      g.fillRect(Math.round(at * w), 0, devicePixelRatio, h);
    }
  }, [buffer, at]);
  return <canvas ref={canvas} className="sound-wave" />;
}
