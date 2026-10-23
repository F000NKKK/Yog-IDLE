import { useEffect, useRef } from "react";
import { peaks } from "./audio";

// A sound's waveform: its loudness along its length, and where it's playing.

/** The waveform's colour, and where the playhead is drawn. */
const WAVE = "#9d7bea";
const HEAD = "#ffffff";

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
    const p = peaks(buffer, w);
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
