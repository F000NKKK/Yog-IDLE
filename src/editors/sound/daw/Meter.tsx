import { useEffect, useRef } from "react";

// A channel's level meter: its loudest sample each frame, while it plays.

/** Samples read a frame. */
const SAMPLES = 1024;
/** How fast the shown level falls back, per frame. */
const FALL = 0.92;

export function Meter({ meter }: { meter: AnalyserNode | null }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!meter) {
      if (bar.current) bar.current.style.height = "0%";
      return;
    }
    const data = new Float32Array(SAMPLES);
    let level = 0, frame = 0;
    const tick = () => {
      meter.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      level = Math.max(peak, level * FALL);
      if (bar.current) {
        bar.current.style.height = `${Math.min(1, level) * 100}%`;
        bar.current.classList.toggle("clip", level >= 1);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [meter]);
  return (
    <div className="daw-meter">
      <div ref={bar} className="daw-meter-bar" />
    </div>
  );
}
